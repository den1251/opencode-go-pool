#!/usr/bin/env node

// src/cli.ts
import { spawn } from "node:child_process";
import { access, readFile as readFile3, unlink as unlink3, writeFile as writeFile2 } from "node:fs/promises";
import { delimiter, join as join4 } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

// src/clear.ts
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
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
async function readUsageEntries(directory, filter = {}) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json"))
      continue;
    try {
      const entry = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (filter.all || matchesFilter(entry, filter))
        entries.push(entry);
    } catch {}
  }
  return entries.sort((left, right) => left.ts - right.ts);
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
      const entry = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (!matchesFilter(entry, filter))
        continue;
      matched += 1;
      await unlink(join(directory, name));
      removed += 1;
    } catch {}
  }
  return { removed, matched };
}

// src/config.ts
import { homedir, platform } from "node:os";
import { join as join2, posix, win32 } from "node:path";
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
function configDirectory(env = process.env, platformName = platform(), home = homedir()) {
  const joinPath = platformName === "win32" ? win32.join : posix.join;
  return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, ".config"), "opencode");
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
    accounts: join2(directory, "accounts.json"),
    quota: join2(directory, "quota.json"),
    cooldown: join2(directory, "cooldown.json"),
    status: join2(directory, "status.json"),
    switches: join2(directory, "switches.json"),
    dashboard: join2(directory, "dashboard.json"),
    clearRequest: join2(directory, "clear-request.json"),
    events: join2(directory, "events"),
    log: join2(directory, "plugin.log")
  };
}

// src/fs-utils.ts
import { randomUUID } from "node:crypto";
import { open, mkdir, readFile as readFile2, rename, stat, unlink as unlink2, writeFile } from "node:fs/promises";
import { dirname, join as join3 } from "node:path";
async function ensureDir(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
}
async function readJson(file) {
  try {
    return JSON.parse(await readFile2(file, "utf8"));
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
  const temporary = join3(dirname(file), `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + `
`, { mode });
  await rename(temporary, file);
}
async function withLock(directory, name, run, timeoutMs = 4000) {
  await ensureDir(directory);
  const file = join3(directory, `.${name}.lock`);
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
        await unlink2(file).catch(() => {});
      if (Date.now() - started > timeoutMs)
        throw new Error(`Timed out waiting for lock ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await run();
  } finally {
    await unlink2(file).catch(() => {});
  }
}

// src/status.ts
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
function formatStatusTable(status) {
  const lines = [];
  lines.push(`OpenCode Go Pool — ${status.accounts.length} account${status.accounts.length === 1 ? "" : "s"}`);
  lines.push("");
  const widths = [2, 22, 12, 20, 20, 20, 10, 10, 10];
  const row = (cells) => cells.map((value, index) => truncate(value, widths[index]).padEnd(widths[index])).join("  ").trimEnd();
  lines.push(row(["#", "Account", "Key", "5h", "Week", "Month", "Today", "Month $", "Plan $"]));
  status.accounts.forEach((account, index) => {
    const mark = account.active ? "*" : account.usable ? " " : "x";
    lines.push(row([
      `${mark}${index + 1}`,
      account.label,
      account.keyHint,
      quotaCell(account.quota?.rolling),
      quotaCell(account.quota?.weekly),
      quotaCell(account.quota?.monthly),
      money(account.today.cost),
      money(account.month.cost),
      account.month.allowance > 0 ? money(account.month.allowance) : "—"
    ]));
  });
  lines.push("");
  const totals = `This machine: ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${tokensText(status.month.tokens)} · ${status.month.entries} request(s)`;
  if (sameTotals(status.today, status.month)) {
    lines.push(totals);
  } else {
    lines.push(`Today: ${money(status.today.cost)} list · ${planText(status.today.allowance)} · ${tokensText(status.today.tokens)} · ${status.today.entries} request(s)`);
    lines.push(`This month: ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${tokensText(status.month.tokens)} · ${status.month.entries} request(s)`);
  }
  if (status.month.estimated > 0) {
    lines.push(`Cost includes catalog estimates for ${status.month.estimated} request(s) without an exact list cost.`);
  }
  if (status.dashboard)
    lines.push(`Dashboard: ${status.dashboard.url}`);
  lines.push(`Machine: ${status.machineID}`);
  if (status.lastError)
    lines.push(`Last error: ${status.lastError}`);
  const last = status.switches[0];
  if (last)
    lines.push(`Last switch: ${last.from ?? "none"} → ${last.to} (${last.reason})`);
  return lines.join(`
`);
}
function sameTotals(left, right) {
  return left.entries === right.entries && left.cost === right.cost && left.allowance === right.allowance && left.tokens.input === right.tokens.input && left.tokens.output === right.tokens.output && left.tokens.reasoning === right.tokens.reasoning && left.tokens.cacheRead === right.tokens.cacheRead && left.tokens.cacheWrite === right.tokens.cacheWrite;
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
function truncate(value, length) {
  return value.length <= length ? value : value.slice(0, length - 1) + "…";
}

// src/cli.ts
var directory = dataDirectory();
var files = paths(directory);
async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  switch (command) {
    case "status":
      return status(args);
    case "accounts":
    case "list":
      return accounts();
    case "use":
      return use(args[0]);
    case "add":
    case "login":
      return add();
    case "refresh":
      return refresh();
    case "clear":
      return clear(args);
    case "export":
      return exportUsage(args);
    case "open":
      return openDashboard();
    case "url":
      return printURL();
    case "install":
    case "where":
      return showInstall(args);
    case "uninstall":
      return uninstall();
    case "help":
    case "--help":
    case "-h":
      return help();
    case "version":
    case "--version":
    case "-v":
      return console.log("opencode-go-pool 0.1.0");
    default:
      console.error(`Unknown command: ${command}`);
      help();
      process.exitCode = 1;
  }
}
async function status(args) {
  const value = await readStatus();
  if (!value) {
    console.log(`No status yet. Start OpenCode once with the plugin installed.
Data directory: ${directory}`);
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(formatStatusTable(value));
}
async function accounts() {
  const value = await readStatus();
  if (!value) {
    console.log(`No accounts recorded yet. Add one with: opencode auth login opencode-go`);
    return;
  }
  for (const [index, account] of value.accounts.entries()) {
    console.log(`${index + 1}. ${account.active ? "*" : " "} ${account.label} (${account.keyHint}) — ${account.usable ? "ready" : "blocked"}`);
  }
}
async function use(selector) {
  if (!selector) {
    console.error("Usage: opencode-go-pool use <number|id|label>");
    process.exitCode = 1;
    return;
  }
  const value = await readStatus();
  if (!value) {
    console.error("No status yet. Start OpenCode once first.");
    process.exitCode = 1;
    return;
  }
  const byIndex = /^\d+$/.test(selector) ? value.accounts[Number(selector) - 1] : undefined;
  const account = byIndex ?? value.accounts.find((item) => item.id === selector || item.label === selector) ?? undefined;
  if (!account) {
    console.error(`Account not found: ${selector}`);
    process.exitCode = 1;
    return;
  }
  const stateFile = files.accounts;
  const next = await withLock(directory, "accounts", async () => {
    const current = await readJson(stateFile) ?? {
      version: 1,
      order: value.accounts.map((item) => item.id),
      disabled: [],
      updatedAt: 0
    };
    const next = { ...current, activeID: account.id, updatedAt: Date.now() };
    await writeJsonAtomic(stateFile, next);
    return next;
  });
  await markStatusActive(account.id);
  console.log(`Active account: ${account.label} (${next.activeID})`);
}
async function markStatusActive(accountID) {
  const status = await readStatus();
  if (!status)
    return;
  status.activeID = accountID;
  for (const item of status.accounts)
    item.active = item.id === accountID;
  await writeJsonAtomic(files.status, status, 384);
}
async function add() {
  const binary = await findExecutable("opencode");
  if (!binary) {
    console.error("The opencode binary was not found on PATH.");
    process.exitCode = 1;
    return;
  }
  console.log("Adding an OpenCode Go account through OpenCode's own login flow.");
  console.log("Run this once per account. The pool discovers all of them automatically.");
  const child = spawn(binary, ["auth", "login", "opencode-go"], { stdio: "inherit" });
  const code = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? 1)));
  if (code !== 0)
    process.exitCode = code;
}
async function refresh() {
  const info = await readJson(files.dashboard);
  if (!info?.url || !info.token) {
    console.error("No dashboard is running. Start OpenCode with the plugin installed.");
    process.exitCode = 1;
    return;
  }
  const response = await fetch(new URL(`/api/refresh?token=${encodeURIComponent(info.token)}`, info.url), {
    method: "POST"
  });
  if (!response.ok) {
    console.error(`Refresh failed: ${response.status}`);
    process.exitCode = 1;
    return;
  }
  const value = await response.json();
  console.log(formatStatusTable(value));
}
async function openDashboard() {
  const info = await readJson(files.dashboard);
  if (!info?.url) {
    console.error("No dashboard is running. Start OpenCode with the plugin installed.");
    process.exitCode = 1;
    return;
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", info.url] : [info.url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
  console.log(info.url);
}
async function showInstall(args) {
  if (args.includes("--link")) {
    console.warn("--link is deprecated: OpenCode 2.2.6 does not run HTTP hooks for auto-discovered plugin directories.");
    console.warn("Use `opencode plugin add opencode-go-pool` (or the install menu) instead.");
    return;
  }
  if (args.includes("--yes") || !process.stdin.isTTY) {
    await installPackage();
    return;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("");
    console.log("OpenCode Go Pool installer");
    console.log(`Data directory: ${directory}`);
    console.log("");
    while (true) {
      console.log("1) Install the plugin into OpenCode");
      console.log("2) Uninstall the plugin");
      console.log("3) Show installation status");
      console.log("4) Quit");
      const answer = (await readline.question("> ")).trim();
      if (answer === "1") {
        await installPackage();
        continue;
      }
      if (answer === "2") {
        await uninstall();
        continue;
      }
      if (answer === "3") {
        await showInstallationStatus();
        continue;
      }
      if (answer === "4" || answer.toLowerCase() === "q")
        return;
      console.log("Choose 1, 2, 3 or 4.");
    }
  } finally {
    readline.close();
  }
}
async function installPackage() {
  const binary = await findExecutable("opencode");
  if (!binary) {
    console.error("The opencode binary was not found on PATH.");
    process.exitCode = 1;
    return;
  }
  console.log(`Installing opencode-go-pool into ${binary}...`);
  const code = await runOpencode(binary, ["plugin", "add", "opencode-go-pool"]);
  if (code !== 0) {
    console.error("Installation failed. The package must be published to npm first.");
    console.error("For a local checkout, add its absolute directory to the global config's `plugins` array.");
    process.exitCode = code;
    return;
  }
  console.log("Installed. Restart OpenCode to load the plugin. Use the opencode-go-pool CLI for status.");
}
async function uninstall() {
  const binary = await findExecutable("opencode");
  const root = packageRoot().replace(/[\\/]+$/, "");
  if (binary) {
    for (const target of ["opencode-go-pool", root]) {
      await runOpencode(binary, ["plugin", "remove", target], true);
    }
  }
  await unlink3(join4(configDirectory(), "plugin", "opencode-go-pool")).catch(() => {});
  if (await pluginEntryRemains(root)) {
    console.error("The plugin entry is still present in the OpenCode config.");
    console.error(`Remove ${root} or opencode-go-pool from ${join4(configDirectory(), "opencode.jsonc")} manually.`);
    process.exitCode = 1;
    return;
  }
  console.log("Plugin entry removed. Restart OpenCode to unload it.");
  console.log(`Local usage data is kept at: ${directory}`);
  console.log("Delete that directory manually if you also want to remove the history.");
}
async function pluginEntryRemains(root) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const text = await readFile3(join4(configDirectory(), name), "utf8").catch(() => "");
    if (text.includes(root) || text.includes("opencode-go-pool"))
      return true;
  }
  return false;
}
async function showInstallationStatus() {
  const binary = await findExecutable("opencode");
  if (binary)
    await runOpencode(binary, ["plugin", "list"]);
  else
    console.log("The opencode binary was not found on PATH.");
  console.log(`Data directory: ${directory}`);
}
async function runOpencode(binary, args, quiet = false) {
  const child = spawn(binary, args, { stdio: quiet ? "ignore" : "inherit" });
  return new Promise((resolve) => child.on("exit", (value) => resolve(value ?? 1)));
}
function packageRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}
async function printURL() {
  const info = await readJson(files.dashboard);
  if (!info?.url) {
    console.error("No dashboard is running. Start OpenCode with the plugin installed.");
    process.exitCode = 1;
    return;
  }
  console.log(info.url);
}
async function clear(args) {
  const filter = {};
  let yes = false;
  for (let index = 0;index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--all")
      filter.all = true;
    else if (argument === "--yes" || argument === "-y")
      yes = true;
    else if (argument === "--owner")
      filter.owner = args[++index];
    else if (argument === "--account")
      filter.accountID = await resolveAccount(args[++index]);
    else if (argument === "--today")
      filter.day = new Date().toISOString().slice(0, 10);
    else if (argument === "--month")
      filter.month = args[++index];
    else if (argument?.startsWith("--month="))
      filter.month = argument.slice("--month=".length);
    else if (argument?.startsWith("--owner="))
      filter.owner = argument.slice("--owner=".length);
    else if (argument?.startsWith("--account="))
      filter.accountID = await resolveAccount(argument.slice("--account=".length));
    else {
      console.error(`Unknown option: ${argument}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!filter.all && !filter.owner && !filter.accountID && !filter.day && !filter.month) {
    filter.all = true;
  }
  const scope = describeFilter(filter);
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(`Refusing to clear without confirmation. Re-run with --yes to clear: ${scope}`);
      process.exitCode = 1;
      return;
    }
    const answer = await confirm(`Delete local usage (${scope})? Account quota is not affected. [y/N] `);
    if (!answer) {
      console.log("Cancelled.");
      return;
    }
  }
  const dashboard = await readJson(files.dashboard);
  if (dashboard?.url && dashboard.token) {
    const response = await fetch(new URL(`/api/clear?token=${encodeURIComponent(dashboard.token)}`, dashboard.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...filter, confirm: true })
    });
    const body = await response.json();
    if (!response.ok) {
      console.error(body.error ?? `Clear failed: ${response.status}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Cleared ${body.removed ?? 0} local entry(ies).`);
    if (body.status)
      console.log(formatStatusTable(body.status));
    return;
  }
  const result = await clearUsage(files.events, filter);
  await writeJsonAtomic(files.clearRequest, { at: Date.now() }, 384);
  console.log(`Cleared ${result.removed} local entry(ies).`);
  console.log("OpenCode will rebuild its status on the next activity.");
}
async function exportUsage(args) {
  const filter = {};
  let csv = false;
  let out;
  for (let index = 0;index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--csv")
      csv = true;
    else if (argument === "--json")
      csv = false;
    else if (argument === "--out")
      out = args[++index];
    else if (argument === "--owner")
      filter.owner = args[++index];
    else if (argument === "--month")
      filter.month = args[++index];
    else if (argument?.startsWith("--out="))
      out = argument.slice("--out=".length);
    else if (argument?.startsWith("--owner="))
      filter.owner = argument.slice("--owner=".length);
    else if (argument?.startsWith("--month="))
      filter.month = argument.slice("--month=".length);
    else {
      console.error(`Unknown option: ${argument}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!filter.owner && !filter.month)
    filter.all = true;
  const entries = await readUsageEntries(files.events, filter);
  const text = csv ? toCSV(entries) : JSON.stringify(entries, null, 2);
  if (out) {
    await writeFile2(out, text + (csv ? `
` : ""), { mode: 384 });
    console.log(`Wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to ${out}`);
    return;
  }
  console.log(text);
}
async function resolveAccount(selector) {
  if (!selector)
    return selector;
  const status = await readStatus();
  if (/^\d+$/.test(selector)) {
    const indexed = status?.accounts[Number(selector) - 1];
    if (indexed)
      return indexed.id;
  }
  const account = status?.accounts.find((item) => item.id === selector || item.label === selector);
  return account?.id ?? selector;
}
function describeFilter(filter) {
  if (filter.all)
    return "all usage on this PC";
  const parts = [
    filter.owner ? `owner ${filter.owner}` : undefined,
    filter.accountID ? `account ${filter.accountID}` : undefined,
    filter.day ? `day ${filter.day}` : undefined,
    filter.month ? `month ${filter.month}` : undefined
  ].filter((value) => value !== undefined);
  return parts.join(", ") || "all usage on this PC";
}
async function confirm(question) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
function toCSV(entries) {
  const header = [
    "timestamp",
    "day",
    "owner",
    "machineID",
    "accountID",
    "accountLabel",
    "providerID",
    "model",
    "source",
    "cost",
    "listCost",
    "allowance",
    "charged",
    "billingSource",
    "metering",
    "estimated",
    "input",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
    "sessionID"
  ];
  const rows = entries.map((entry) => [
    new Date(entry.ts).toISOString(),
    entry.day,
    entry.owner,
    entry.machineID,
    entry.accountID,
    entry.accountLabel,
    entry.providerID,
    entry.model,
    entry.source,
    entry.cost,
    entry.listCost ?? "",
    entry.allowance ?? "",
    entry.charged ?? "",
    entry.billingSource ?? "",
    entry.metering ?? "",
    entry.estimated,
    entry.tokens.input,
    entry.tokens.output,
    entry.tokens.reasoning,
    entry.tokens.cacheRead,
    entry.tokens.cacheWrite,
    entry.sessionID
  ].map((value) => csvCell(value)).join(","));
  return [header.join(","), ...rows].join(`
`);
}
function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function readStatus() {
  try {
    return JSON.parse(await readFile3(files.status, "utf8"));
  } catch {
    return;
  }
}
async function findExecutable(name) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join4(directory, name + extension);
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
  }
  return;
}
function help() {
  console.log(`opencode-go-pool — multi-account quota and spend for OpenCode Go

Usage:
  opencode-go-pool status [--json]     Show accounts, quota and spend
  opencode-go-pool accounts           List discovered accounts
  opencode-go-pool use <n|id|label>   Make an account active
  opencode-go-pool add                Add an account through OpenCode login
  opencode-go-pool refresh            Refresh quota through the running dashboard
  opencode-go-pool clear [options]    Delete local usage (account/day/month/all)
  opencode-go-pool export [options]   Export local usage as JSON or CSV
  opencode-go-pool open               Open the dashboard in a browser
  opencode-go-pool url                Print the dashboard URL
  opencode-go-pool install            Interactive install menu
  opencode-go-pool install --yes      Install without the menu
  opencode-go-pool uninstall          Remove the plugin entry

Clear options:
  --account <n>    only this account
  --today          only today
  --month YYYY-MM  only this month
  --all            every local usage entry
  --yes            skip confirmation

Export options:
  --month YYYY-MM  only this month
  --csv            CSV instead of JSON
  --out <file>     write to a file

Environment:
  OPENCODE_GO_POOL_DIR                Override the data directory
                                      (default: ~/.local/share/opencode-go-pool)`);
}
main();
