import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { Status } from "./types"

export interface DashboardOptions {
  port: number
  host?: string
  getStatus: () => Promise<Status>
  refresh: () => Promise<void>
  clear: (filter: { owner?: string; accountID?: string; day?: string; month?: string; all?: boolean }) => Promise<{ removed: number }>
}

export interface Dashboard {
  url: string
  port: number
  token: string
  close: () => Promise<void>
}

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const token = randomBytes(18).toString("hex")
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.searchParams.get("token") !== token) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
      response.end("Forbidden")
      return
    }
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        })
        response.end(HTML)
        return
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const status = await options.getStatus()
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify(status))
        return
      }
      if (request.method === "POST" && url.pathname === "/api/refresh") {
        await options.refresh()
        const status = await options.getStatus()
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify(status))
        return
      }
      if (request.method === "POST" && url.pathname === "/api/clear") {
        const body = (await readBody(request)) as {
          owner?: string
          accountID?: string
          day?: string
          month?: string
          all?: boolean
          confirm?: boolean
        }
        if (body.all && body.confirm !== true) {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: "all clear requires confirm: true" }))
          return
        }
        const removed = await options.clear({
          ...(body.owner ? { owner: body.owner } : {}),
          ...(body.accountID ? { accountID: body.accountID } : {}),
          ...(body.day ? { day: body.day } : {}),
          ...(body.month ? { month: body.month } : {}),
          ...(body.all ? { all: true } : {}),
        })
        const status = await options.getStatus()
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify({ removed: removed.removed, status }))
        return
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end("Not found")
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : options.port
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function readBody(request: import("node:http").IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

const HTML = String.raw`<!doctype html>
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
    : status.month.models.map((model) => '<tr><td class="mono">' + escapeHTML(model.modelName ?? model.model) + '</td><td class="num">' + model.requests + '</td><td class="num">' + compact(model.input) + '</td><td class="num">' + compact(model.output) + '</td><td class="num">' + money(model.cost) + '</td><td class="num">' + (model.allowance > 0 ? money(model.allowance) : '—') + '</td></tr>').join("");

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
</html>`
