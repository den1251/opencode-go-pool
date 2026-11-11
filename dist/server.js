// src/server.ts
import { appendFile, rename as rename2, stat as stat2 } from "node:fs/promises";

// src/auth.ts
function applyAuthorization(headers, account) {
  headers.set("authorization", `Bearer ${account.token}`);
  if (account.orgID) {
    headers.set("x-opencode-org-id", account.orgID);
    headers.set("x-org-id", account.orgID);
  } else {
    headers.delete("x-opencode-org-id");
    headers.delete("x-org-id");
  }
}

// src/fs-utils.ts
import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
async function ensureDir(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
}
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    if (error instanceof SyntaxError)
      return;
    throw error;
  }
}
async function writeJsonAtomic(file, value, mode = 384) {
  await ensureDir(dirname(file));
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + `
`, { mode });
  await rename(temporary, file);
}
async function withLock(directory, name, run, timeoutMs = 4000) {
  await ensureDir(directory);
  const file = join(directory, `.${name}.lock`);
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(file, "wx", 384);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const age = await stat(file).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > 15000)
        await unlink(file).catch(() => {});
      if (Date.now() - started > timeoutMs)
        throw new Error(`Timed out waiting for lock ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await run();
  } finally {
    await unlink(file).catch(() => {});
  }
}

// src/quota.ts
var WINDOWS = ["rolling", "weekly", "monthly"];
async function fetchQuota(account, options) {
  const headers = {
    authorization: `Bearer ${account.token}`,
    accept: "application/json",
    "user-agent": "opencode-go-pool/0.1"
  };
  if (account.orgID) {
    headers["x-opencode-org-id"] = account.orgID;
    headers["x-org-id"] = account.orgID;
  }
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.usageURL, { headers, signal: controller.signal });
    if (response.status === 401)
      return { fetchedAt: Date.now(), error: "key rejected (401)" };
    if (response.status === 403)
      return { fetchedAt: Date.now(), error: "no Go subscription (403)" };
    if (!response.ok)
      return { fetchedAt: Date.now(), error: `usage request failed (${response.status})` };
    const body = await response.json();
    return parseQuota(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fetchedAt: Date.now(), error: `usage request failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
function parseQuota(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object")
    return { fetchedAt: Date.now(), error: "usage response has no usage object" };
  const snapshot = { fetchedAt: Date.now() };
  for (const name of WINDOWS) {
    const raw = usage[name];
    if (!raw || typeof raw !== "object")
      continue;
    snapshot[name] = parseWindow(raw);
  }
  if (!snapshot.rolling && !snapshot.weekly && !snapshot.monthly) {
    return { fetchedAt: Date.now(), error: "usage response has no windows" };
  }
  return snapshot;
}
function parseWindow(raw) {
  const value = raw;
  const percent = typeof value.percent === "number" && Number.isFinite(value.percent) ? value.percent : 0;
  const status = typeof value.status === "string" ? value.status : "unknown";
  const resetsAt = parseTime(value.resetsAt);
  return {
    percent,
    status,
    limited: status === "rate-limited" || percent >= 100,
    resetsAt
  };
}
function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 10000000000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function loadQuotaCache(value) {
  if (!value || value.version !== 1 || typeof value.accounts !== "object")
    return { version: 1, accounts: {} };
  return value;
}
function quotaFresh(snapshot, refreshSeconds, now = Date.now()) {
  return snapshot !== undefined && now - snapshot.fetchedAt < refreshSeconds * 1000;
}
function windows(snapshot) {
  if (!snapshot)
    return [];
  return WINDOWS.flatMap((name) => {
    const value = snapshot[name];
    return value ? [value] : [];
  });
}
function isExhausted(snapshot, threshold, now = Date.now()) {
  if (!snapshot || snapshot.error)
    return false;
  for (const window of windows(snapshot)) {
    if (window.resetsAt !== null && window.resetsAt <= now)
      continue;
    if (window.limited)
      return true;
    if (window.percent >= threshold)
      return true;
  }
  return false;
}
function nextReset(snapshot, now = Date.now()) {
  const resets = windows(snapshot).map((window) => window.resetsAt).filter((value) => value !== null && value > now);
  return resets.length === 0 ? null : Math.min(...resets);
}
function limitingReset(snapshot, now = Date.now()) {
  if (!snapshot)
    return null;
  const resets = windows(snapshot).filter((window) => window.limited || window.percent >= 100).map((window) => window.resetsAt).filter((value) => value !== null && value > now);
  return resets.length === 0 ? null : Math.max(...resets);
}
function inCooldown(cooldownUntil, now = Date.now()) {
  return cooldownUntil !== undefined && cooldownUntil > now;
}

// src/cache-store.ts
async function readQuotaCache(file) {
  return loadQuotaCache(await readJson(file));
}
async function writeQuotaCache(file, directory, cache) {
  await withLock(directory, "quota", () => writeJsonAtomic(file, cache));
}
async function readCooldowns(file) {
  const value = await readJson(file);
  if (!value || value.version !== 1 || typeof value.accounts !== "object")
    return { version: 1, accounts: {} };
  return value;
}
async function writeCooldown(file, directory, accountID, until) {
  return withLock(directory, "cooldown", async () => {
    const current = await readCooldowns(file);
    current.accounts[accountID] = until;
    await writeJsonAtomic(file, current);
    return current;
  });
}

// src/clear.ts
import { readdir, readFile as readFile2, unlink as unlink2 } from "node:fs/promises";
import { join as join2 } from "node:path";
function matchesFilter(entry, filter) {
  if (filter.all)
    return true;
  if (filter.owner !== undefined && entry.owner !== filter.owner)
    return false;
  if (filter.accountID !== undefined && entry.accountID !== filter.accountID)
    return false;
  if (filter.day !== undefined && entry.day !== filter.day)
    return false;
  if (filter.month !== undefined && !entry.day.startsWith(filter.month))
    return false;
  return filter.owner !== undefined || filter.accountID !== undefined || filter.day !== undefined || filter.month !== undefined;
}
async function clearUsage(directory, filter) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return { removed: 0, matched: 0 };
  }
  let removed = 0;
  let matched = 0;
  for (const name of names) {
    if (!name.endsWith(".json"))
      continue;
    try {
      const entry = JSON.parse(await readFile2(join2(directory, name), "utf8"));
      if (!matchesFilter(entry, filter))
        continue;
      matched += 1;
      await unlink2(join2(directory, name));
      removed += 1;
    } catch {}
  }
  return { removed, matched };
}

// src/pricing.ts
function estimateCost(tiers, tokens) {
  if (!tiers || tiers.length === 0)
    return 0;
  const context = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const tier = tiers.filter((item) => item.tier?.type === "context" && context > item.tier.size).sort((left, right) => (right.tier?.size ?? 0) - (left.tier?.size ?? 0))[0] ?? tiers.find((item) => item.tier === undefined);
  if (!tier)
    return 0;
  return (tokens.input * tier.input + (tokens.output + tokens.reasoning) * tier.output + tokens.cacheRead * tier.cache.read + tokens.cacheWrite * tier.cache.write) / 1e6;
}

// src/config.ts
import { homedir, platform } from "node:os";
import { join as join3, posix, win32 } from "node:path";
function defaultDataDirectory(env = process.env, platformName = platform(), home = homedir()) {
  if (env.OPENCODE_GO_POOL_DIR)
    return expandHome(env.OPENCODE_GO_POOL_DIR, home, platformName);
  if (platformName === "win32") {
    return win32.join(env.APPDATA ?? win32.join(home, "AppData", "Roaming"), "opencode-go-pool");
  }
  if (platformName === "darwin") {
    return posix.join(home, "Library", "Application Support", "opencode-go-pool");
  }
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), "opencode-go-pool");
}
function dataDirectory(options) {
  return options?.dataDir ? expandHome(options.dataDir) : defaultDataDirectory();
}
function expandHome(value, home = homedir(), platformName = platform()) {
  if (value === "~")
    return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return (platformName === "win32" ? win32 : posix).join(home, value.slice(2));
  }
  return value;
}
function paths(directory) {
  return {
    directory,
    accounts: join3(directory, "accounts.json"),
    quota: join3(directory, "quota.json"),
    cooldown: join3(directory, "cooldown.json"),
    status: join3(directory, "status.json"),
    switches: join3(directory, "switches.json"),
    dashboard: join3(directory, "dashboard.json"),
    clearRequest: join3(directory, "clear-request.json"),
    events: join3(directory, "events"),
    log: join3(directory, "plugin.log")
  };
}
var DEFAULT_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
var DEFAULT_UPSTREAM = "https://opencode.ai";
function settings(options) {
  return {
    owner: options?.owner,
    switchAtPercent: clamp(options?.switchAtPercent ?? 100, 1, 100),
    refreshSeconds: Math.max(1, options?.refreshSeconds ?? 60),
    dashboard: options?.dashboard ?? false,
    dashboardPort: options?.dashboardPort ?? 0,
    usageURL: (options?.usageURL ?? DEFAULT_USAGE_URL).replace(/\/+$/, ""),
    upstream: (options?.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, ""),
    requestTimeoutMs: Math.max(500, options?.requestTimeoutMs ?? 5000),
    debug: options?.debug ?? false
  };
}
function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value))
    return maximum;
  return Math.min(maximum, Math.max(minimum, value));
}

// src/discovery.ts
import { createHash } from "node:crypto";
var GO_INTEGRATION_ID = "opencode-go";
async function discoverAccounts(ctx) {
  const result = await ctx.integration.list();
  const integrations = result.data ?? [];
  const accounts = [];
  const seen = new Set;
  const seenOrg = new Set;
  const add = (account) => {
    if (account.orgID) {
      if (seenOrg.has(account.orgID))
        return;
      seenOrg.add(account.orgID);
    }
    const fingerprint = createHash("sha256").update(account.token).digest("hex").slice(0, 16);
    if (seen.has(fingerprint))
      return;
    seen.add(fingerprint);
    accounts.push(account);
  };
  for (const integration of integrations) {
    if (integration.id !== GO_INTEGRATION_ID)
      continue;
    for (const connection of integration.connections) {
      if (connection.status?.status === "needs_auth")
        continue;
      if (connection.type !== "credential" && connection.type !== "env")
        continue;
      const resolved = await ctx.integration.connection.resolve(connection);
      if (!resolved)
        continue;
      if (resolved.type === "key" && resolved.key) {
        add({
          id: connection.type === "credential" ? connection.id ?? `credential:${connection.label}` : `env:${connection.name}`,
          label: connection.type === "credential" ? connection.label || "OpenCode Go" : `Environment ${connection.name}`,
          method: "key",
          token: resolved.key,
          keyHint: `...${resolved.key.slice(-4)}`,
          source: connection.type
        });
      } else if (resolved.type === "oauth" && resolved.access) {
        add({
          id: `console:${connection.id ?? connection.label}`,
          label: connection.label || "OpenCode Console",
          method: "oauth",
          token: resolved.access,
          ...orgID(resolved) ? { orgID: orgID(resolved) } : {},
          ...resolved.expires ? { expires: normalizeExpiry(resolved.expires) } : {},
          keyHint: orgID(resolved) ? `org ${orgID(resolved).slice(-6)}` : "...oauth",
          source: "credential"
        });
      }
    }
  }
  for (const integration of integrations) {
    if (integration.id !== "opencode")
      continue;
    for (const connection of integration.connections) {
      if (connection.status?.status === "needs_auth")
        continue;
      if (connection.type !== "credential" || connection.method !== "oauth")
        continue;
      const resolved = await ctx.integration.connection.resolve(connection);
      if (!resolved || resolved.type !== "oauth" || !resolved.access)
        continue;
      add({
        id: `console:${connection.id ?? connection.label}`,
        label: connection.label || "OpenCode Console",
        method: "oauth",
        token: resolved.access,
        ...orgID(resolved) ? { orgID: orgID(resolved) } : {},
        ...resolved.expires ? { expires: normalizeExpiry(resolved.expires) } : {},
        keyHint: orgID(resolved) ? `org ${orgID(resolved).slice(-6)}` : "...oauth",
        source: "credential"
      });
    }
  }
  return accounts;
}
function orgID(value) {
  const id = value.metadata?.orgID;
  return typeof id === "string" ? id : undefined;
}
function normalizeExpiry(value) {
  return value < 10000000000 ? value * 1000 : value;
}

// src/dashboard.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
async function startDashboard(options) {
  const token = randomBytes(18).toString("hex");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
        });
        response.end(HTML);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const status = await options.getStatus();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(status));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/refresh") {
        await options.refresh();
        const status = await options.getStatus();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(status));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/clear") {
        const body = await readBody(request);
        if (body.all && body.confirm !== true) {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "all clear requires confirm: true" }));
          return;
        }
        const removed = await options.clear({
          ...body.owner ? { owner: body.owner } : {},
          ...body.accountID ? { accountID: body.accountID } : {},
          ...body.day ? { day: body.day } : {},
          ...body.month ? { month: body.month } : {},
          ...body.all ? { all: true } : {}
        });
        const status = await options.getStatus();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ removed: removed.removed, status }));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
var HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Go Pool</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #14171c;
    --panel-2: #1a1e24;
    --border: #262b33;
    --text: #e7e9ee;
    --muted: #8b93a1;
    --accent: #7c9cff;
    --good: #3ddc97;
    --warn: #f7b955;
    --bad: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(1200px 600px at 20% -10%, #1a2233 0%, var(--bg) 55%);
    color: var(--text);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    min-height: 100vh;
  }
  main { max-width: 1120px; margin: 0 auto; padding: 40px 24px 64px; }
  header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  button {
    appearance: none; border: 1px solid var(--border); background: var(--panel);
    color: var(--text); border-radius: 8px; padding: 8px 12px; cursor: pointer;
  }
  button:hover { border-color: #3a4250; background: var(--panel-2); }
  button:disabled { opacity: 0.55; cursor: wait; }
  .actions { display: flex; gap: 8px; }
  button.danger { color: var(--bad); border-color: #4a2529; }
  button.danger:hover { background: #1d1214; border-color: #6b3038; }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
  .stat .value { font-size: 22px; font-weight: 650; margin-top: 4px; }
  .stat .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .accounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  .card.active { border-color: #35508f; box-shadow: 0 0 0 1px #2b4177 inset; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .name { font-weight: 650; font-size: 15px; }
  .key { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px; }
  .badge { border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .badge.active { color: var(--accent); border-color: #35508f; background: #141d33; }
  .badge.blocked { color: var(--bad); border-color: #5a2b2b; background: #211314; }
  .meter { margin-top: 10px; }
  .meter-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--muted); }
  .meter-row b { color: var(--text); font-weight: 600; }
  .track { height: 7px; border-radius: 99px; background: #0a0c0f; border: 1px solid #222731; overflow: hidden; margin-top: 5px; }
  .fill { height: 100%; border-radius: 99px; background: var(--good); }
  .fill.warn { background: var(--warn); }
  .fill.bad { background: var(--bad); }
  .empty { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .card-foot { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); margin-top: 16px; padding-top: 10px; color: var(--muted); font-size: 12px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 30px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .error { color: var(--bad); }
  footer { color: var(--muted); font-size: 12px; margin-top: 28px; }
  @media (max-width: 720px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>OpenCode Go Pool</h1>
      <div class="sub" id="updated">Loading...</div>
    </div>
    <div class="actions">
      <button id="clear" class="danger">Clear my usage...</button>
      <button id="refresh">Refresh quota</button>
    </div>
  </header>
  <div class="sub" style="margin:-14px 0 18px">Quota percentages are account-wide. List value, plan usage and tokens are from this machine only.</div>

  <section class="stats" id="stats"></section>
  <section class="accounts" id="accounts"></section>

  <h2>Models this month</h2>
  <table>
    <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th><th class="num">List $</th><th class="num">Plan $</th></tr></thead>
    <tbody id="models"><tr><td colspan="6" class="empty">No usage recorded yet.</td></tr></tbody>
  </table>

  <h2>Recent switches</h2>
  <table>
    <thead><tr><th>When</th><th>From</th><th>To</th><th>Reason</th></tr></thead>
    <tbody id="switches"><tr><td colspan="4" class="empty">No switches yet.</td></tr></tbody>
  </table>

  <footer id="footer"></footer>
</main>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const plural = (value, word) => Number(value) === 1 ? "1 " + word : Number(value) + " " + word + "s";
const money = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "$0.00";
  if (number < 0.0001) return "$" + number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  if (number < 0.01) return "$" + number.toFixed(6);
  if (number < 1) return "$" + number.toFixed(4);
  return "$" + number.toFixed(2);
};
const compact = (value) => value >= 1e6 ? (value / 1e6).toFixed(1) + "M" : value >= 1e3 ? (value / 1e3).toFixed(1) + "k" : String(value || 0);
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (ts) => {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  if (seconds < 86400) return (seconds / 3600).toFixed(1) + "h";
  return (seconds / 86400).toFixed(1) + "d";
};
const date = (ts) => ts ? new Date(ts).toLocaleString() : "—";
let lastStatus = null;

function meter(name, window) {
  if (!window) return '<div class="meter"><div class="meter-row"><span>' + name + '</span><span>unavailable</span></div></div>';
  const percent = Math.max(0, Math.min(100, Number(window.percent || 0)));
  const cls = percent >= 90 ? "bad" : percent >= 70 ? "warn" : "";
  const reset = window.resetsAt ? " · resets in " + when(window.resetsAt) : "";
  return '<div class="meter"><div class="meter-row"><span>' + name + '</span><span><b>' + percent.toFixed(1) + '%</b>' + (window.limited ? " · limit" : "") + reset + '</span></div><div class="track"><div class="fill ' + cls + '" style="width:' + percent + '%"></div></div></div>';
}

function render(status) {
  lastStatus = status;
  const active = status.accounts.find((account) => account.active);
  document.getElementById("updated").textContent = "Updated " + new Date(status.generatedAt).toLocaleTimeString() + (status.lastError ? " · " + status.lastError : "") + (status.month.estimated > 0 ? " · cost includes catalog estimates" : "");
  document.getElementById("stats").innerHTML = [
    ["Month list", money(status.month.cost), plural(status.month.entries, "request")],
    ["Month plan", status.month.allowance > 0 ? money(status.month.allowance) : "n/a", "OpenCode Go allowance"],
    ["Today", money(status.today.cost), plural(status.today.entries, "request")],
    ["Active account", active ? active.label : "none", active ? active.keyHint : "add an account"],
  ].map(([label, value, note]) => '<div class="stat"><div class="label">' + label + '</div><div class="value">' + escapeHTML(value) + '</div><div class="note">' + escapeHTML(note) + '</div></div>').join("");

  document.getElementById("accounts").innerHTML = status.accounts.length === 0
    ? '<div class="card empty">No OpenCode Go connections found. Add one in OpenCode, then reload.</div>'
    : status.accounts.map((account) => {
        const badge = account.active ? "active" : account.usable ? "ready" : "blocked";
        const quota = account.quota;
        const error = quota && quota.error ? '<div class="empty error">Quota unavailable: ' + escapeHTML(quota.error) + '</div>' : "";
        return '<div class="card ' + (account.active ? "active" : "") + '">' +
          '<div class="card-head"><div><div class="name">' + escapeHTML(account.label) + '</div><div class="key">' + escapeHTML(account.keyHint) + ' · ' + escapeHTML(account.method) + '</div></div><span class="badge ' + badge + '">' + badge + '</span></div>' +
          meter("5 hours", quota && quota.rolling) + meter("This week", quota && quota.weekly) + meter("This month", quota && quota.monthly) + error +
          '<div class="card-foot"><span>Today ' + money(account.today.cost) + (account.today.allowance > 0 ? ' · plan ' + money(account.today.allowance) : '') + '</span><span>Month ' + money(account.month.cost) + (account.month.allowance > 0 ? ' · plan ' + money(account.month.allowance) : '') + '</span></div>' +
          '</div>';
      }).join("");

  document.getElementById("models").innerHTML = status.month.models.length === 0
    ? '<tr><td colspan="6" class="empty">No usage recorded yet.</td></tr>'
    : status.month.models.map((model) => '<tr><td class="mono">' + escapeHTML(model.model) + '</td><td class="num">' + model.requests + '</td><td class="num">' + compact(model.input) + '</td><td class="num">' + compact(model.output) + '</td><td class="num">' + money(model.cost) + '</td><td class="num">' + (model.allowance > 0 ? money(model.allowance) : '—') + '</td></tr>').join("");

  document.getElementById("switches").innerHTML = status.switches.length === 0
    ? '<tr><td colspan="4" class="empty">No switches yet.</td></tr>'
    : status.switches.map((item) => '<tr><td>' + date(item.ts) + '</td><td>' + escapeHTML(item.from || "none") + '</td><td>' + escapeHTML(item.to) + '</td><td>' + escapeHTML(item.reason) + '</td></tr>').join("");

  document.getElementById("footer").textContent = "Data directory: " + status.dataDir + " · machine " + status.machineID;
}

async function load() {
  const response = await fetch("/api/status?token=" + encodeURIComponent(token));
  if (!response.ok) throw new Error("status request failed: " + response.status);
  render(await response.json());
}

document.getElementById("refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Refreshing...";
  try {
    const response = await fetch("/api/refresh?token=" + encodeURIComponent(token), { method: "POST" });
    if (!response.ok) throw new Error("refresh failed: " + response.status);
    render(await response.json());
  } catch (error) {
    document.getElementById("updated").textContent = String(error);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh quota";
  }
});

document.getElementById("clear").addEventListener("click", async (event) => {
  if (!lastStatus) return;
  if (!confirm('Delete all local usage recorded on this PC? Account quota is not affected.')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/api/clear?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true, confirm: true }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "clear failed");
    render(body.status);
    document.getElementById("updated").textContent = "Cleared " + body.removed + " local entr" + (body.removed === 1 ? "y" : "ies") + " on this PC";
  } catch (error) {
    document.getElementById("updated").textContent = String(error);
  } finally {
    button.disabled = false;
  }
});

load().catch((error) => { document.getElementById("updated").textContent = String(error); });
setInterval(load, 5000);
</script>
</body>
</html>`;

// src/identity.ts
import { userInfo } from "node:os";
import { join as join4 } from "node:path";
function ownerFile(directory) {
  return join4(directory, "owner.json");
}
function cleanOwner(value) {
  if (typeof value !== "string")
    return;
  const cleaned = value.trim().replaceAll(/\s+/g, " ").slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}
async function resolveOwner(directory, configured) {
  const record = await readJson(ownerFile(directory));
  if (record?.version === 1 && cleanOwner(record.name))
    return cleanOwner(record.name);
  return cleanOwner(configured) ?? cleanOwner(process.env.OPENCODE_GO_POOL_OWNER) ?? defaultOwner();
}
function defaultOwner() {
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

// src/machine.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { join as join5 } from "node:path";
async function resolveMachine(directory) {
  const file = join5(directory, "machine.json");
  const record = await readJson(file);
  if (record?.version === 1 && typeof record.id === "string" && record.id.length > 0)
    return record.id;
  const id = `mch_${randomUUID2().slice(0, 8)}`;
  await writeJsonAtomic(file, { version: 1, id, createdAt: Date.now() });
  return id;
}

// src/ledger.ts
import { mkdir as mkdir2, readdir as readdir2, readFile as readFile3, unlink as unlink3, writeFile as writeFile2 } from "node:fs/promises";
import { join as join6 } from "node:path";
var EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
function normalizeTokens(value) {
  const tokens = value ?? {};
  const cache = tokens.cache ?? {};
  return {
    input: number(tokens.input),
    output: number(tokens.output),
    reasoning: number(tokens.reasoning),
    cacheRead: number(cache.read),
    cacheWrite: number(cache.write)
  };
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function monthKey(ts) {
  return dayKey(ts).slice(0, 7);
}
async function recordUsage(directory, entry) {
  await mkdir2(directory, { recursive: true, mode: 448 });
  const safe = entry.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = join6(directory, `${entry.day}__${safe}.json`);
  try {
    await writeFile2(file, JSON.stringify(entry) + `
`, { flag: "wx", mode: 384 });
    return true;
  } catch (error) {
    if (error.code === "EEXIST")
      return false;
    throw error;
  }
}
async function aggregateUsage(directory, options = {}) {
  const prefix = options.day ?? options.month ?? "";
  const since = options.day ? Date.parse(`${options.day}T00:00:00.000Z`) : options.month ? Date.parse(`${options.month}-01T00:00:00.000Z`) : 0;
  const aggregate = {
    since,
    entries: 0,
    estimated: 0,
    cost: 0,
    listCost: 0,
    allowance: 0,
    charged: 0,
    tokens: { ...EMPTY_TOKENS },
    models: [],
    accounts: {},
    owners: {},
    billing: {}
  };
  let names;
  try {
    names = await readdir2(directory);
  } catch (error) {
    if (error.code === "ENOENT")
      return aggregate;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || !name.startsWith(prefix))
      continue;
    let entry;
    try {
      entry = JSON.parse(await readFile3(join6(directory, name), "utf8"));
    } catch {
      continue;
    }
    applyEntry(aggregate, entry);
  }
  return aggregate;
}
function add(aggregate, entry) {
  const listCost = entry.listCost ?? 0;
  const allowance = entry.allowance ?? 0;
  const charged = entry.charged ?? 0;
  aggregate.entries += 1;
  if (entry.estimated)
    aggregate.estimated += 1;
  aggregate.cost += entry.cost;
  aggregate.listCost += listCost;
  aggregate.allowance += allowance;
  aggregate.charged += charged;
  addTokens(aggregate.tokens, entry.tokens);
  if (entry.billingSource)
    aggregate.billing[entry.billingSource] = (aggregate.billing[entry.billingSource] ?? 0) + 1;
  const account = aggregate.accounts[entry.accountID] ?? emptyUsage();
  account.requests += 1;
  account.cost += entry.cost;
  account.listCost += listCost;
  account.allowance += allowance;
  account.charged += charged;
  addTokens(account.tokens, entry.tokens);
  aggregate.accounts[entry.accountID] = account;
  const owner = aggregate.owners[entry.owner] ?? emptyUsage();
  owner.requests += 1;
  owner.cost += entry.cost;
  owner.listCost += listCost;
  owner.allowance += allowance;
  owner.charged += charged;
  addTokens(owner.tokens, entry.tokens);
  aggregate.owners[entry.owner] = owner;
  const key = `${entry.providerID}/${entry.model}`;
  const model = aggregate.models.find((item) => `${item.providerID}/${item.model}` === key);
  if (model) {
    model.requests += 1;
    model.cost += entry.cost;
    model.listCost += listCost;
    model.allowance += allowance;
    addTokens(model, entry.tokens);
  } else {
    aggregate.models.push({
      providerID: entry.providerID,
      model: entry.model,
      requests: 1,
      cost: entry.cost,
      listCost,
      allowance,
      ...entry.tokens
    });
  }
}
function emptyUsage() {
  return { requests: 0, cost: 0, listCost: 0, allowance: 0, charged: 0, tokens: { ...EMPTY_TOKENS } };
}
function applyEntry(aggregate, entry) {
  add(aggregate, entry);
  aggregate.models.sort((left, right) => right.cost - left.cost || right.requests - left.requests);
}
function addTokens(target, value) {
  target.input += value.input;
  target.output += value.output;
  target.reasoning += value.reasoning;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
}
async function pruneUsage(directory, keepDays = 120) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const cutoffDay = dayKey(cutoff);
  let names;
  try {
    names = await readdir2(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const day = name.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoffDay)
      continue;
    await unlink3(join6(directory, name)).catch(() => {});
  }
}

// src/state-store.ts
async function loadAccountState(file) {
  const value = await readJson(file);
  if (!value || value.version !== 1)
    return;
  return value;
}
async function reconcileAccounts(file, directory, accounts) {
  return withLock(directory, "accounts", async () => {
    const current = await loadAccountState(file);
    const available = new Set(accounts.map((account) => account.id));
    const order = (current?.order ?? []).filter((id) => available.has(id));
    for (const account of accounts)
      if (!order.includes(account.id))
        order.push(account.id);
    const disabled = (current?.disabled ?? []).filter((id) => available.has(id));
    const activeID = current?.activeID && available.has(current.activeID) && !disabled.includes(current.activeID) ? current.activeID : order.find((id) => !disabled.includes(id));
    const next = {
      version: 1,
      order,
      disabled,
      ...activeID ? { activeID } : {},
      updatedAt: Date.now()
    };
    const same = current !== undefined && current.activeID === next.activeID && current.order.length === next.order.length && current.order.every((id, index) => next.order[index] === id) && current.disabled.length === next.disabled.length && current.disabled.every((id, index) => next.disabled[index] === id);
    if (!same)
      await writeJsonAtomic(file, next);
    return next;
  });
}
async function setActiveAccount(file, directory, activeID) {
  return withLock(directory, "accounts", async () => {
    const current = await loadAccountState(file) ?? { version: 1, order: [], disabled: [], updatedAt: 0 };
    const next = { ...current, activeID, updatedAt: Date.now() };
    await writeJsonAtomic(file, next);
    return next;
  });
}
function orderedAccounts(accounts, state) {
  const byID = new Map(accounts.map((account) => [account.id, account]));
  const ordered = state.order.flatMap((id) => {
    const account = byID.get(id);
    return account ? [account] : [];
  });
  for (const account of accounts)
    if (!ordered.some((item) => item.id === account.id))
      ordered.push(account);
  return ordered;
}

// src/selection.ts
function accountUsable(accountID, state, quotas, cooldowns, threshold, now = Date.now()) {
  if (state.disabled.includes(accountID))
    return false;
  if (inCooldown(cooldowns.accounts[accountID], now))
    return false;
  const snapshot = quotas.accounts[accountID];
  if (snapshot?.error && /(401|403)/.test(snapshot.error))
    return false;
  return !isExhausted(snapshot, threshold, now);
}
async function selectAccount(input) {
  const now = input.now ?? Date.now();
  const ordered = orderedAccounts(input.accounts, input.state);
  const candidates = ordered.filter((account) => !input.exclude?.has(account.id) && !input.state.disabled.includes(account.id));
  const previousID = input.state.activeID;
  const active = candidates.find((account) => account.id === previousID);
  if (active) {
    const quota = await input.ensureQuota?.(active) ?? input.quotas.accounts[active.id];
    if (quota)
      input.quotas.accounts[active.id] = quota;
    if (accountUsable(active.id, input.state, input.quotas, input.cooldowns, input.threshold, now)) {
      return { account: active, previousID, changed: false, reason: "active", nextReset: null };
    }
  }
  let earliest = null;
  for (const account of candidates) {
    if (account.id === active?.id)
      continue;
    const quota = await input.ensureQuota?.(account) ?? input.quotas.accounts[account.id];
    if (quota)
      input.quotas.accounts[account.id] = quota;
    if (accountUsable(account.id, input.state, input.quotas, input.cooldowns, input.threshold, now)) {
      const reason = inCooldown(input.cooldowns.accounts[account.id], now) ? "cooldown" : "quota";
      return {
        account,
        previousID,
        changed: account.id !== previousID,
        reason: active ? reason : "fallback",
        nextReset: null
      };
    }
    const reset = nextReset(quota, now);
    if (reset !== null && (earliest === null || reset < earliest))
      earliest = reset;
  }
  if (active) {
    const reset = nextReset(input.quotas.accounts[active.id], now);
    if (reset !== null && (earliest === null || reset < earliest))
      earliest = reset;
  }
  return { account: undefined, previousID, changed: false, reason: "exhausted", nextReset: earliest };
}

// src/status.ts
function buildStatus(input) {
  const now = Date.now();
  const accounts = input.state.order.flatMap((id) => {
    const account = input.accounts.find((item) => item.id === id);
    if (!account)
      return [];
    const today = input.today.accounts[id] ?? emptyUsage();
    const month = input.month.accounts[id] ?? emptyUsage();
    const cooldownUntil = input.cooldowns.accounts[id] ?? null;
    return [
      {
        id: account.id,
        label: account.label,
        keyHint: account.keyHint,
        method: account.method,
        active: input.state.activeID === id,
        usable: accountUsable(id, input.state, input.quotas, input.cooldowns, input.threshold, now),
        disabled: input.state.disabled.includes(id),
        cooldownUntil: cooldownUntil !== null && cooldownUntil > now ? cooldownUntil : null,
        quota: input.quotas.accounts[id] ?? null,
        today: { cost: today.cost, tokens: today.tokens, allowance: today.allowance },
        month: { cost: month.cost, tokens: month.tokens, allowance: month.allowance }
      }
    ];
  });
  return {
    version: 1,
    generatedAt: now,
    dataDir: input.dataDir,
    owner: input.owner,
    machineID: input.machineID,
    activeID: input.state.activeID ?? null,
    accounts,
    today: input.today,
    month: input.month,
    switches: input.switches.slice(-10).reverse(),
    ...input.dashboard ? { dashboard: input.dashboard } : {},
    ...input.lastError ? { lastError: input.lastError } : {}
  };
}
async function writeStatus(file, status) {
  await writeJsonAtomic(file, status, 384);
}
async function readSwitches(file) {
  const value = await readJson(file);
  return Array.isArray(value) ? value : [];
}
async function appendSwitch(file, entry) {
  const current = await readSwitches(file);
  current.push(entry);
  await writeJsonAtomic(file, current.slice(-100), 420);
}
function money(value) {
  if (!Number.isFinite(value) || value <= 0)
    return "$0.00";
  if (value < 0.0001)
    return `$${trimZeros(value.toFixed(8))}`;
  if (value < 0.01)
    return `$${value.toFixed(6)}`;
  if (value < 1)
    return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
function trimZeros(value) {
  return value.replace(/0+$/, "").replace(/\.$/, "");
}
function compact(value) {
  if (value >= 1e6)
    return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1000)
    return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
function tokensText(tokens) {
  return `${compact(tokens.input)} in / ${compact(tokens.output)} out`;
}
function planText(allowance) {
  return allowance > 0 ? `${money(allowance)} plan` : "plan n/a";
}
function formatStatusMarkdown(status) {
  const lines = [];
  lines.push(`### OpenCode Go pool`);
  lines.push("");
  lines.push("| | Account | Key | 5h | Week | Month | Today | Month $ | Plan $ |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const account of status.accounts) {
    const mark = account.active ? "**active**" : account.usable ? "ready" : "blocked";
    lines.push(`| ${mark} | ${escape(account.label)} | \`${account.keyHint}\` | ${quotaCell(account.quota?.rolling)} | ${quotaCell(account.quota?.weekly)} | ${quotaCell(account.quota?.monthly)} | ${money(account.today.cost)} | ${money(account.month.cost)} | ${account.month.allowance > 0 ? money(account.month.allowance) : "—"} |`);
  }
  lines.push("");
  lines.push(`**This machine today:** ${money(status.today.cost)} list · ${planText(status.today.allowance)} · ${tokensText(status.today.tokens)} · ${status.today.entries} request(s)`);
  lines.push(`**This machine month:** ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${tokensText(status.month.tokens)} · ${status.month.entries} request(s)`);
  if (status.month.models.length > 0) {
    lines.push("");
    lines.push("| Model | Requests | Tokens | List $ | Plan $ |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const model of status.month.models.slice(0, 12)) {
      lines.push(`| ${escape(model.model)} | ${model.requests} | ${compact(model.input + model.output + model.reasoning)} | ${money(model.cost)} | ${model.allowance > 0 ? money(model.allowance) : "—"} |`);
    }
  }
  if (status.month.estimated > 0) {
    lines.push("");
    lines.push(`_Cost includes catalog estimates for ${status.month.estimated} request(s) without an exact list cost._`);
  }
  if (status.dashboard) {
    lines.push("");
    lines.push(`[Open dashboard](${status.dashboard.url})`);
  }
  lines.push("");
  lines.push(`Machine: \`${status.machineID}\``);
  return lines.join(`
`);
}
function quotaCell(value) {
  if (!value)
    return "—";
  const reset = value.resetsAt ? ` (${resetText(value.resetsAt)})` : "";
  return `${value.limited ? "LIMIT " : ""}${value.percent.toFixed(1)}%${reset}`;
}
function resetText(ts) {
  const seconds = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (seconds < 60)
    return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400)
    return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
function escape(value) {
  return value.replaceAll("|", "\\|");
}

// src/usage.ts
function normalizeRawUsage(value) {
  const root = record(value);
  if (!root)
    return;
  const response = record(root.response);
  const candidates = [
    record(root.usage),
    record(response?.usage),
    record(root.usageMetadata),
    record(response?.usageMetadata)
  ];
  for (const usage of candidates) {
    if (!usage)
      continue;
    const parsed = readUsage(usage);
    if (parsed)
      return parsed;
  }
  return;
}
function readUsage(usage) {
  const opencode = record(usage.opencode);
  const opencodeTokens = record(opencode?.tokens);
  const tokens = opencodeTokens ? readTokenFields(opencodeTokens) : readStandardTokens(usage);
  const charged = numberValue(usage.cost);
  const listCost = numberValue(opencode?.list_cost) ?? numberValue(opencode?.listCost);
  const allowance = numberValue(opencode?.allowance);
  const billingSource = stringValue(opencode?.billing_source) ?? stringValue(opencode?.billingSource);
  if (!tokens && charged === undefined && listCost === undefined && allowance === undefined && billingSource === undefined) {
    return;
  }
  return {
    ...tokens ? { tokens } : {},
    ...charged !== undefined ? { charged } : {},
    ...listCost !== undefined ? { listCost } : {},
    ...allowance !== undefined ? { allowance } : {},
    ...billingSource ? { billingSource } : {}
  };
}
function readTokenFields(raw) {
  const input = numberValue(raw.input);
  const billedOutput = numberValue(raw.output);
  const reasoning = numberValue(raw.reasoning);
  const cacheRead = numberValue(raw.cache_read) ?? numberValue(raw.cacheRead);
  const cacheWrite = (numberValue(raw.cache_write_5m) ?? 0) + (numberValue(raw.cache_write_1h) ?? 0) + (numberValue(raw.cache_write) ?? numberValue(raw.cacheWrite) ?? 0);
  const hasWrite = numberValue(raw.cache_write_5m) !== undefined || numberValue(raw.cache_write_1h) !== undefined || numberValue(raw.cache_write) !== undefined || numberValue(raw.cacheWrite) !== undefined;
  if (input === undefined && billedOutput === undefined && reasoning === undefined && cacheRead === undefined && !hasWrite) {
    return;
  }
  return {
    ...input !== undefined ? { input } : {},
    ...billedOutput !== undefined ? { output: Math.max(0, billedOutput - (reasoning ?? 0)) } : {},
    ...reasoning !== undefined ? { reasoning } : {},
    ...cacheRead !== undefined ? { cacheRead } : {},
    ...hasWrite ? { cacheWrite } : {}
  };
}
function readStandardTokens(usage) {
  const prompt = numberValue(usage.prompt_tokens);
  const completion = numberValue(usage.completion_tokens);
  const anthropicInput = numberValue(usage.input_tokens);
  const anthropicOutput = numberValue(usage.output_tokens);
  const geminiPrompt = numberValue(usage.promptTokenCount);
  const geminiOutput = numberValue(usage.candidatesTokenCount);
  const cached = numberValue(record(usage.prompt_tokens_details)?.cached_tokens) ?? numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.prompt_cache_hit_tokens) ?? numberValue(usage.cachedContentTokenCount);
  const cacheWrite = numberValue(usage.cache_creation_input_tokens) ?? numberValue(usage.prompt_cache_miss_tokens);
  const reasoning = numberValue(record(usage.completion_tokens_details)?.reasoning_tokens) ?? numberValue(usage.reasoning_tokens) ?? numberValue(record(usage.output_tokens_details)?.reasoning_tokens) ?? numberValue(usage.thoughtsTokenCount);
  const input = prompt !== undefined ? Math.max(0, prompt - (cached ?? 0)) : anthropicInput !== undefined ? anthropicInput : geminiPrompt !== undefined ? Math.max(0, geminiPrompt - (cached ?? 0)) : undefined;
  const output = completion !== undefined ? Math.max(0, completion - (reasoning ?? 0)) : anthropicOutput !== undefined ? Math.max(0, anthropicOutput - (reasoning ?? 0)) : geminiOutput !== undefined ? Math.max(0, geminiOutput - (reasoning ?? 0)) : undefined;
  if (input === undefined && output === undefined && cached === undefined && cacheWrite === undefined && reasoning === undefined) {
    return;
  }
  return {
    ...input !== undefined ? { input } : {},
    ...output !== undefined ? { output } : {},
    ...reasoning !== undefined ? { reasoning } : {},
    ...cached !== undefined ? { cacheRead: cached } : {},
    ...cacheWrite !== undefined ? { cacheWrite } : {}
  };
}
async function readResponseUsage(response) {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream"))
    return readStreamUsage(response);
  let text;
  try {
    text = await response.text();
  } catch {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed)
    return;
  if (trimmed.startsWith("data:") || contentType.includes("ndjson"))
    return readLines(trimmed);
  try {
    return normalizeRawUsage(JSON.parse(trimmed));
  } catch {
    return readLines(trimmed);
  }
}
async function readStreamUsage(response) {
  const body = response.body;
  if (!body)
    return readLines(await response.text().catch(() => ""));
  const reader = body.getReader();
  const decoder = new TextDecoder;
  let buffer = "";
  let usage;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf(`
`);
      while (index >= 0) {
        usage = readLine(buffer.slice(0, index), usage);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf(`
`);
      }
    }
    buffer += decoder.decode();
    if (buffer)
      usage = readLine(buffer, usage);
  } catch {
    return usage;
  } finally {
    reader.releaseLock();
  }
  return usage;
}
function readLines(text) {
  let usage;
  for (const line of text.split(/\r?\n/))
    usage = readLine(line, usage);
  return usage;
}
function readLine(line, current) {
  const trimmed = line.trim();
  if (!trimmed)
    return current;
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!data || data === "[DONE]" || data.startsWith("event:"))
    return current;
  try {
    return mergeUsage(current, normalizeRawUsage(JSON.parse(data)));
  } catch {
    return current;
  }
}
function mergeUsage(current, next) {
  if (!next)
    return current;
  if (!current)
    return next;
  return {
    ...current,
    ...next,
    ...next.tokens ? { tokens: { ...current.tokens, ...next.tokens } } : {}
  };
}
function record(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// src/server.ts
var SHARED_STATE_KEY = "__opencodeGoPoolSharedStateV1";
function sharedState(directory) {
  const holder = globalThis;
  const states = holder[SHARED_STATE_KEY] ??= new Map;
  const existing = states.get(directory);
  if (existing) {
    existing.lastBySession ??= new Map;
    existing.pendingUsage ??= [];
    existing.requestContexts ??= new WeakMap;
    existing.processedEvents ??= new Map;
    return existing;
  }
  const created = {
    lastBySession: new Map,
    pendingUsage: [],
    requestContexts: new WeakMap,
    processedEvents: new Map
  };
  states.set(directory, created);
  return created;
}
var PLUGIN_ID = "opencode-go-pool";
var PROVIDER_ID = "opencode-go";
var DASHBOARDS_KEY = "__opencodeGoPoolDashboardsV1";
function dashboardRegistry() {
  const holder = globalThis;
  return holder[DASHBOARDS_KEY] ??= new Map;
}
var server_default = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = ctx.options ?? {};
    const directory = dataDirectory(options);
    const files = paths(directory);
    const config = settings(options);
    await ensureDir(directory);
    await ensureDir(files.events);
    const logger = createLogger(files.log, config.debug);
    const shared = sharedState(directory);
    const requestContexts = shared.requestContexts;
    const lastBySession = shared.lastBySession;
    const pendingUsage = shared.pendingUsage;
    const processedEvents = shared.processedEvents;
    const pricing = new Map;
    let pricingAt = 0;
    const inFlight = new Map;
    const registrations = [];
    const dashboardRef = { value: undefined };
    let dashboardEntry;
    let stopped = false;
    let accounts = [];
    let state = { version: 1, order: [], disabled: [], updatedAt: 0 };
    let quotas = await readQuotaCache(files.quota);
    let cooldowns = await readCooldowns(files.cooldown);
    let switches = await readSwitches(files.switches);
    let aggregates = await loadAggregates();
    let lastError;
    let owner = await resolveOwner(directory, config.owner);
    let ownerAt = Date.now();
    const machineID = await resolveMachine(directory);
    let statusTimer;
    let statusDue = Number.POSITIVE_INFINITY;
    let discoveryTimer;
    let discoveryAttempt = 0;
    let lastReloadAt = 0;
    let eventIterator;
    let eventLoop;
    async function loadAggregates() {
      const now = Date.now();
      const [today, month] = await Promise.all([
        aggregateUsage(files.events, { day: dayKey(now) }),
        aggregateUsage(files.events, { month: monthKey(now) })
      ]);
      return { at: now, day: dayKey(now), monthKey: monthKey(now), today, month };
    }
    async function loadPricing(force = false) {
      if (!force && Date.now() - pricingAt < 5 * 60000)
        return;
      try {
        const result = await ctx.model.list();
        for (const model of result.data) {
          if (model.providerID !== PROVIDER_ID)
            continue;
          pricing.set(model.id, model.cost);
        }
        pricingAt = Date.now();
      } catch (error) {
        logger.error("failed to load model pricing", error);
      }
    }
    async function estimatedCostFor(modelID, tokens) {
      if (pricing.size === 0 || !pricing.has(modelID))
        await loadPricing();
      return estimateCost(pricing.get(modelID), tokens);
    }
    function scheduleStatus(delay = 250) {
      if (stopped)
        return;
      const due = Date.now() + delay;
      if (statusTimer && statusDue <= due)
        return;
      if (statusTimer)
        clearTimeout(statusTimer);
      statusDue = due;
      statusTimer = setTimeout(() => {
        statusTimer = undefined;
        statusDue = Number.POSITIVE_INFINITY;
        writeCurrentStatus().catch((error) => logger.error("failed to write status", error));
      }, delay);
      statusTimer.unref?.();
    }
    async function currentOwner() {
      if (Date.now() - ownerAt < 5000)
        return owner;
      owner = await resolveOwner(directory, config.owner);
      ownerAt = Date.now();
      return owner;
    }
    function makeStatus() {
      return buildStatus({
        dataDir: directory,
        owner,
        machineID,
        accounts,
        state,
        quotas,
        cooldowns,
        today: aggregates.today,
        month: aggregates.month,
        switches,
        ...dashboardRef.value ? { dashboard: { url: dashboardRef.value.url, port: dashboardRef.value.port } } : {},
        threshold: config.switchAtPercent,
        ...lastError ? { lastError } : {}
      });
    }
    async function writeCurrentStatus() {
      const marker = await readJson(files.clearRequest);
      if (typeof marker?.at === "number" && marker.at > aggregates.at)
        aggregates = await loadAggregates();
      await writeStatus(files.status, makeStatus());
    }
    async function refreshQuota(account, force = false) {
      const cached = quotas.accounts[account.id];
      if (!force && cached && quotaFresh(cached, config.refreshSeconds))
        return cached;
      const pending = inFlight.get(account.id);
      if (pending)
        return pending;
      const task = fetchQuota(account, {
        usageURL: config.usageURL,
        timeoutMs: config.requestTimeoutMs
      }).then(async (snapshot) => {
        quotas.accounts[account.id] = snapshot;
        await writeQuotaCache(files.quota, directory, quotas).catch((error) => logger.error("failed to persist quota cache", error));
        scheduleStatus();
        return snapshot;
      }).finally(() => inFlight.delete(account.id));
      inFlight.set(account.id, task);
      return task;
    }
    async function refreshAll(force = true) {
      for (const account of accounts) {
        await refreshQuota(account, force);
      }
    }
    async function reloadAccounts() {
      if (stopped)
        return;
      try {
        const discovered = await discoverAccounts(ctx);
        accounts = discovered;
        lastReloadAt = Date.now();
        if (accounts.length === 0) {
          const ids = await integrationIDs();
          logger.info("no OpenCode Go connections found yet", {
            integrations: ids.filter((id) => id === "opencode" || id === "opencode-go")
          });
          if (discoveryAttempt < 8) {
            const delay = Math.min(30000, 100 * 2 ** discoveryAttempt);
            discoveryAttempt += 1;
            scheduleDiscovery(delay);
          }
        } else {
          discoveryAttempt = 0;
        }
        state = await reconcileAccounts(files.accounts, directory, accounts);
        scheduleStatus(50);
        refreshAll(true).catch((error) => logger.error("failed to refresh quotas", error));
      } catch (error) {
        logger.error("failed to discover accounts", error);
      }
    }
    async function integrationIDs() {
      try {
        const result = await ctx.integration.list();
        return (result.data ?? []).map((item) => item.id);
      } catch {
        return [];
      }
    }
    function scheduleDiscovery(delay = 150) {
      if (stopped)
        return;
      if (discoveryTimer)
        clearTimeout(discoveryTimer);
      discoveryTimer = setTimeout(() => {
        discoveryTimer = undefined;
        reloadAccounts();
      }, delay);
      discoveryTimer.unref?.();
    }
    async function select(exclude) {
      const current = await loadAccountState(files.accounts) ?? state;
      state = current;
      const result = await selectAccount({
        accounts,
        state,
        quotas,
        cooldowns,
        threshold: config.switchAtPercent,
        ...exclude ? { exclude } : {},
        ensureQuota: (account) => refreshQuota(account)
      });
      if (result.account && result.changed) {
        state = await setActiveAccount(files.accounts, directory, result.account.id);
        const from = accounts.find((item) => item.id === result.previousID);
        const entry = {
          ts: Date.now(),
          from: from?.label ?? null,
          to: result.account.label,
          reason: result.reason
        };
        switches = [...switches, entry];
        await appendSwitch(files.switches, entry).catch((error) => logger.error("failed to persist switch", error));
        logger.info(`switched to ${result.account.label}`, { reason: result.reason });
        scheduleStatus(30);
      }
      if (result.account)
        lastError = undefined;
      else if (accounts.length > 0)
        lastError = "all OpenCode Go accounts are exhausted";
      return result;
    }
    function applyHeaders(headers, account) {
      applyAuthorization(headers, account);
    }
    async function onRequest(input) {
      if (stopped)
        return;
      if (accounts.some((account) => account.expires !== undefined && account.expires < Date.now() + 5 * 60000)) {
        if (Date.now() - lastReloadAt > 30000)
          await reloadAccounts();
      }
      let selection = await select();
      let account = selection.account;
      let exhausted = false;
      if (!account) {
        const fallback = accounts.find((item) => item.id === state.activeID) ?? accounts[0];
        if (!fallback) {
          requestContexts.set(input.request, {
            accountID: "none",
            accountLabel: "none",
            providerID: input.model.providerID,
            modelID: input.model.id,
            sessionID: input.sessionID,
            kind: input.kind,
            at: Date.now(),
            exhausted: true
          });
          return;
        }
        account = fallback;
        exhausted = true;
      }
      const headers = new Headers(input.request.headers);
      applyHeaders(headers, account);
      const url = rewriteURL(input.request.url, config.upstream);
      let next;
      try {
        next = rebuildRequest(input.request, url, headers);
      } catch (error) {
        logger.error("failed to rewrite request", error);
        return;
      }
      let template;
      try {
        template = next.clone();
      } catch {
        template = undefined;
      }
      requestContexts.set(next, {
        accountID: account.id,
        accountLabel: account.label,
        providerID: input.model.providerID,
        modelID: input.model.id,
        sessionID: input.sessionID,
        kind: input.kind,
        at: Date.now(),
        exhausted,
        ...template ? { template } : {}
      });
      input.request = next;
    }
    async function onResponse(input) {
      if (stopped)
        return;
      const context = requestContexts.get(input.request);
      if (!context)
        return;
      if (context.accountID === "none") {
        input.response = exhaustedResponse(null, accounts.length);
        return;
      }
      if (input.response.ok) {
        captureUsage(input.response, context);
        commitUse(context);
        refreshQuotaIfStale(context.accountID);
        return;
      }
      if (![401, 403, 429].includes(input.response.status))
        return;
      const attempted = new Set([context.accountID]);
      let response = input.response;
      await markFailure(context, response);
      while (!stopped && attempted.size < accounts.length) {
        const selection = await select(attempted);
        if (!selection.account)
          break;
        attempted.add(selection.account.id);
        const template = context.template;
        if (!template)
          break;
        const retryHeaders = new Headers(template.headers);
        applyHeaders(retryHeaders, selection.account);
        let retry;
        try {
          retry = rebuildRequest(template.clone(), template.url, retryHeaders);
        } catch (error) {
          logger.error("failed to build retry request", error);
          break;
        }
        let retryResponse;
        try {
          retryResponse = await fetch(retry, { signal: AbortSignal.timeout(60000) });
        } catch (error) {
          logger.error("retry request failed", error);
          break;
        }
        if (retryResponse.ok) {
          const retryContext = { ...context, accountID: selection.account.id, accountLabel: selection.account.label };
          captureUsage(retryResponse, retryContext);
          await cancelBody(response);
          input.response = retryResponse;
          commitUse(retryContext);
          refreshQuotaIfStale(selection.account.id, true);
          return;
        }
        if (![401, 403, 429].includes(retryResponse.status)) {
          await cancelBody(response);
          input.response = retryResponse;
          return;
        }
        await markFailure({ ...context, accountID: selection.account.id, accountLabel: selection.account.label }, retryResponse);
        await cancelBody(response);
        response = retryResponse;
      }
      const reset = nextReset(quotas.accounts[state.activeID ?? ""]);
      input.response = exhaustedResponse(reset, attempted.size);
      lastError = "all OpenCode Go accounts are exhausted";
      scheduleStatus(30);
    }
    async function refreshQuotaIfStale(accountID, force = false) {
      const account = accounts.find((item) => item.id === accountID);
      if (!account)
        return;
      if (!force && quotaFresh(quotas.accounts[accountID], config.refreshSeconds))
        return;
      await refreshQuota(account, force).catch((error) => logger.error("failed to refresh quota", error));
    }
    async function markFailure(context, response) {
      const now = Date.now();
      if (response.status === 429) {
        const account = accounts.find((item) => item.id === context.accountID);
        if (account)
          await refreshQuota(account, true).catch(() => {});
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now);
        const until = limitingReset(quotas.accounts[context.accountID], now) ?? retryAfter ?? now + 5 * 60000;
        cooldowns = await writeCooldown(files.cooldown, directory, context.accountID, until);
        logger.warn(`account ${context.accountLabel} hit a quota limit`, { until });
      } else {
        cooldowns = await writeCooldown(files.cooldown, directory, context.accountID, now + 15 * 60000);
        lastError = `${context.accountLabel} rejected the request (${response.status})`;
        logger.warn(`account ${context.accountLabel} rejected the request`, { status: response.status });
      }
      scheduleStatus(30);
    }
    function commitUse(context) {
      lastBySession.set(context.sessionID, {
        accountID: context.accountID,
        providerID: context.providerID,
        modelID: context.modelID,
        kind: context.kind,
        at: Date.now()
      });
      if (lastBySession.size > 500) {
        const cutoff = Date.now() - 6 * 60 * 60000;
        for (const [key, value] of lastBySession)
          if (value.at < cutoff)
            lastBySession.delete(key);
      }
    }
    function captureUsage(response, context) {
      let clone;
      try {
        clone = response.clone();
      } catch {
        return;
      }
      pendingUsage.push({
        sessionID: context.sessionID,
        kind: context.kind,
        accountID: context.accountID,
        accountLabel: context.accountLabel,
        providerID: context.providerID,
        modelID: context.modelID,
        at: Date.now(),
        usage: readResponseUsage(clone).catch((error) => {
          logger.error("failed to read usage from response", error);
          return;
        })
      });
      if (pendingUsage.length > 500)
        pendingUsage.splice(0, pendingUsage.length - 500);
    }
    function claimEvent(id) {
      if (processedEvents.has(id))
        return false;
      processedEvents.set(id, Date.now());
      if (processedEvents.size > 5000) {
        const oldest = processedEvents.keys().next().value;
        if (oldest !== undefined)
          processedEvents.delete(oldest);
      }
      return true;
    }
    async function takeUsage(sessionID, kind, modelID) {
      if (pendingUsage.length === 0)
        return;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const exact = pendingUsage.findIndex((item) => item.sessionID === sessionID && item.kind === kind && (!modelID || item.modelID === modelID));
        const index = exact >= 0 ? exact : pendingUsage.findIndex((item) => item.sessionID === sessionID && item.kind === kind);
        if (index >= 0) {
          const item = pendingUsage[index];
          if (!item)
            return;
          pendingUsage.splice(index, 1);
          const usage = await Promise.race([
            item.usage,
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(undefined), 3000);
              timer.unref?.();
            })
          ]).catch(() => {
            return;
          });
          return { ...item, usage };
        }
        await delay(50);
      }
      return;
    }
    async function handleEvent(event) {
      if (stopped)
        return;
      if (event.type === "credential.updated" || event.type === "credential.switched" || event.type === "integration.updated") {
        scheduleDiscovery();
        return;
      }
      if (event.type === "model.updated") {
        pricingAt = 0;
        loadPricing(true);
        return;
      }
      if (event.type === "session.step.ended") {
        await recordStep(event);
      }
    }
    async function recordStep(event) {
      const data = event.data;
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!sessionID)
        return;
      if (!claimEvent(event.id))
        return;
      const last = lastBySession.get(sessionID);
      const modelID = isRecord(data.model) && typeof data.model.id === "string" ? data.model.id : last?.modelID;
      const taken = await takeUsage(sessionID, "primary", modelID);
      const providerID = isRecord(data.model) && typeof data.model.providerID === "string" ? data.model.providerID : taken?.providerID ?? last?.providerID ?? PROVIDER_ID;
      if (providerID !== PROVIDER_ID)
        return;
      await saveUsage({
        id: event.id,
        ts: typeof event.created === "number" ? event.created : Date.now(),
        source: "step",
        sessionID,
        providerID,
        modelID: modelID ?? taken?.modelID ?? last?.modelID ?? "unknown",
        accountID: taken?.accountID ?? last?.accountID ?? "unattributed",
        tokens: normalizeTokens(data.tokens),
        reported: data.cost,
        raw: taken?.usage
      });
    }
    async function saveUsage(input) {
      const account = accounts.find((item) => item.id === input.accountID);
      const tokens = input.raw?.tokens ? { ...input.tokens, ...input.raw.tokens } : input.tokens;
      const reported = typeof input.reported === "number" && Number.isFinite(input.reported) ? Math.max(0, input.reported) : undefined;
      const charged = input.raw?.charged ?? reported;
      const listCost = input.raw?.listCost;
      const estimate = listCost === undefined && (charged === undefined || charged === 0) ? await estimatedCostFor(input.modelID, tokens) : 0;
      const cost = listCost ?? (charged !== undefined && charged > 0 ? charged : estimate);
      const metering = listCost !== undefined ? "response" : charged !== undefined && charged > 0 ? "event" : "estimate";
      const entry = {
        id: input.id,
        ts: input.ts,
        day: dayKey(input.ts),
        owner: await currentOwner(),
        machineID,
        accountID: input.accountID,
        accountLabel: account?.label ?? "unattributed",
        providerID: input.providerID,
        model: input.modelID,
        source: input.source,
        cost,
        estimated: metering === "estimate" && estimate > 0,
        tokens,
        sessionID: input.sessionID,
        ...listCost !== undefined ? { listCost } : {},
        ...input.raw?.allowance !== undefined ? { allowance: input.raw.allowance } : {},
        ...charged !== undefined ? { charged } : {},
        ...input.raw?.billingSource ? { billingSource: input.raw.billingSource } : {},
        metering
      };
      const created = await recordUsage(files.events, entry);
      if (!created)
        return;
      const now = Date.now();
      if (entry.day !== aggregates.day || monthKey(now) !== aggregates.monthKey) {
        aggregates = await loadAggregates();
      } else {
        applyEntry(aggregates.today, entry);
        applyEntry(aggregates.month, entry);
      }
      scheduleStatus();
    }
    function startEventLoop() {
      const iterable = ctx.event.subscribe({
        types: [
          "session.step.ended",
          "credential.updated",
          "credential.switched",
          "integration.updated",
          "model.updated"
        ]
      });
      eventIterator = iterable[Symbol.asyncIterator]();
      eventLoop = (async () => {
        while (!stopped) {
          const next = await eventIterator?.next();
          if (!next || next.done)
            break;
          await handleEvent(next.value).catch((error) => logger.error("failed to handle event", error));
        }
      })().catch((error) => {
        if (!stopped)
          logger.error("event subscription failed", error);
      });
    }
    async function registerCommand() {
      const registration = await ctx.command.transform((editor) => {
        editor.add({
          name: "gopool",
          description: "show OpenCode Go pool quota and spend",
          execute: async (input) => {
            await refreshAll(true).catch((error) => logger.error("failed to refresh quotas", error));
            aggregates = await loadAggregates();
            await currentOwner();
            const status = makeStatus();
            await writeCurrentStatus().catch(() => {});
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: formatStatusMarkdown(status),
              description: "OpenCode Go pool status"
            });
          }
        });
      });
      registrations.push(registration);
    }
    async function registerHooks() {
      const request = await ctx.session.hook("http.request", onRequest, { providerID: PROVIDER_ID });
      registrations.push(request);
      const response = await ctx.session.hook("http.response", onResponse, { providerID: PROVIDER_ID });
      registrations.push(response);
    }
    async function startDashboardIfEnabled() {
      if (!config.dashboard)
        return;
      const dashboards = dashboardRegistry();
      const existing = dashboards.get(directory);
      if (existing) {
        existing.refs += 1;
        dashboardEntry = existing;
        dashboardRef.value = existing.dashboard;
        return;
      }
      try {
        const dashboard = await startDashboard({
          port: config.dashboardPort,
          getStatus: async () => {
            if (Date.now() - aggregates.at > 3000)
              aggregates = await loadAggregates();
            await currentOwner();
            return makeStatus();
          },
          refresh: async () => {
            await refreshAll(true);
            aggregates = await loadAggregates();
            await writeCurrentStatus();
          },
          clear: async (filter) => {
            const result = await clearUsage(files.events, filter);
            aggregates = await loadAggregates();
            await writeCurrentStatus();
            return result;
          }
        });
        dashboardEntry = { dashboard, refs: 1 };
        dashboards.set(directory, dashboardEntry);
        dashboardRef.value = dashboard;
        await writeJsonAtomic(files.dashboard, {
          url: dashboard.url,
          port: dashboard.port,
          token: dashboard.token,
          pid: process.pid
        }, 384);
        logger.info(`dashboard listening on ${dashboard.url}`);
      } catch (error) {
        logger.error("failed to start dashboard", error);
      }
    }
    try {
      await pruneUsage(files.events).catch(() => {});
      await reloadAccounts();
      if (accounts.length === 0)
        logger.warn("no OpenCode Go connections found yet");
      await registerHooks();
      await registerCommand();
      await startDashboardIfEnabled();
      startEventLoop();
      await writeCurrentStatus().catch((error) => logger.error("failed to write initial status", error));
    } catch (error) {
      logger.error("setup failed", error);
    }
    return async () => {
      stopped = true;
      if (statusTimer)
        clearTimeout(statusTimer);
      if (discoveryTimer)
        clearTimeout(discoveryTimer);
      await eventIterator?.return?.().catch(() => {});
      await eventLoop?.catch(() => {});
      for (const registration of registrations)
        await registration.dispose().catch(() => {});
      if (dashboardEntry) {
        dashboardEntry.refs -= 1;
        if (dashboardEntry.refs <= 0) {
          dashboardRegistry().delete(directory);
          await dashboardEntry.dashboard.close().catch(() => {});
          const current = await readJson(files.dashboard);
          if (current?.pid === process.pid) {
            await withLock(directory, "dashboard-file", () => writeJsonAtomic(files.dashboard, {})).catch(() => {});
          }
        }
      }
      await writeCurrentStatus().catch(() => {});
      logger.info("stopped");
    };
  }
};
function rewriteURL(url, upstream) {
  if (upstream === DEFAULT_UPSTREAM)
    return url;
  const source = new URL(url);
  const base = new URL(DEFAULT_UPSTREAM);
  if (source.origin !== base.origin)
    return url;
  return new URL(source.pathname + source.search, upstream).toString();
}
function rebuildRequest(base, url, headers) {
  const method = base.method.toUpperCase();
  const init = {
    method,
    headers,
    redirect: base.redirect,
    signal: base.signal
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = base.body;
    init.duplex = "half";
  }
  return new Request(url, init);
}
async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {}
}
function parseRetryAfter(value, now) {
  if (!value)
    return;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}
function exhaustedResponse(reset, attempts) {
  const when = reset ? new Date(reset).toLocaleString() : "unknown";
  return Response.json({
    error: {
      message: `All ${attempts} OpenCode Go account(s) are exhausted. Next quota reset: ${when}.`,
      type: "go_pool_exhausted"
    }
  }, { status: 429 });
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
function createLogger(file, debug) {
  const write = (level, message, extra) => {
    const suffix = extra === undefined ? "" : ` ${serialize(extra)}`;
    const line = `${new Date().toISOString()} ${level} ${message}${suffix}
`;
    if (debug)
      console.error(line.trimEnd());
    (async () => {
      try {
        const info = await stat2(file).catch(() => {
          return;
        });
        if (info && info.size > 2000000)
          await rename2(file, `${file}.1`).catch(() => {});
        await appendFile(file, line, { mode: 384 });
      } catch {}
    })();
  };
  return {
    info: (message, extra) => write("INFO", message, extra),
    warn: (message, extra) => write("WARN", message, extra),
    error: (message, error) => write("ERROR", message, error)
  };
}
function serialize(value) {
  if (value instanceof Error)
    return JSON.stringify({ message: value.message });
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
export {
  server_default as default
};
