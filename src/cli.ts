#!/usr/bin/env node
import { spawn } from "node:child_process"
import { access, readFile, unlink, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import type { AccountState, ClearFilter, DashboardInfo, Status, UsageEntry } from "./types"
import { clearUsage, readUsageEntries } from "./clear"
import { configDirectory, dataDirectory, paths } from "./config"
import { readJson, withLock, writeJsonAtomic } from "./fs-utils"
import { resolveOwner, setOwner } from "./identity"
import { formatStatusTable } from "./status"

const directory = dataDirectory()
const files = paths(directory)

async function main() {
  const [command = "status", ...args] = process.argv.slice(2)
  switch (command) {
    case "status":
      return status(args)
    case "accounts":
    case "list":
      return accounts()
    case "use":
      return use(args[0])
    case "add":
    case "login":
      return add()
    case "refresh":
      return refresh()
    case "clear":
      return clear(args)
    case "export":
      return exportUsage(args)
    case "owner":
      return ownerCommand(args)
    case "open":
      return openDashboard()
    case "url":
      return printURL()
    case "install":
    case "where":
      return showInstall(args)
    case "uninstall":
      return uninstall()
    case "help":
    case "--help":
    case "-h":
      return help()
    case "version":
    case "--version":
    case "-v":
      return console.log("opencode-go-pool 0.1.0")
    default:
      console.error(`Unknown command: ${command}`)
      help()
      process.exitCode = 1
  }
}

async function status(args: string[]) {
  const value = await readStatus()
  if (!value) {
    console.log(`No status yet. Start OpenCode once with the plugin installed.\nData directory: ${directory}`)
    return
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  console.log(formatStatusTable(value))
}

async function accounts() {
  const value = await readStatus()
  if (!value) {
    console.log(`No accounts recorded yet. Add one with: opencode auth login opencode-go`)
    return
  }
  for (const [index, account] of value.accounts.entries()) {
    console.log(
      `${index + 1}. ${account.active ? "*" : " "} ${account.label} (${account.keyHint}) — ${account.usable ? "ready" : "blocked"}`,
    )
  }
}

async function use(selector: string | undefined) {
  if (!selector) {
    console.error("Usage: opencode-go-pool use <number|id|label>")
    process.exitCode = 1
    return
  }
  const value = await readStatus()
  if (!value) {
    console.error("No status yet. Start OpenCode once first.")
    process.exitCode = 1
    return
  }
  const byIndex = /^\d+$/.test(selector) ? value.accounts[Number(selector) - 1] : undefined
  const account =
    byIndex ?? value.accounts.find((item) => item.id === selector || item.label === selector) ?? undefined
  if (!account) {
    console.error(`Account not found: ${selector}`)
    process.exitCode = 1
    return
  }
  const stateFile = files.accounts
  const next = await withLock(directory, "accounts", async () => {
    const current = (await readJson<AccountState>(stateFile)) ?? {
      version: 1 as const,
      order: value.accounts.map((item) => item.id),
      disabled: [],
      updatedAt: 0,
    }
    const next: AccountState = { ...current, activeID: account.id, updatedAt: Date.now() }
    await writeJsonAtomic(stateFile, next)
    return next
  })
  await markStatusActive(account.id)
  console.log(`Active account: ${account.label} (${next.activeID})`)
}

async function markStatusActive(accountID: string) {
  const status = await readStatus()
  if (!status) return
  status.activeID = accountID
  for (const item of status.accounts) item.active = item.id === accountID
  await writeJsonAtomic(files.status, status, 0o600)
}

async function add() {
  const binary = await findExecutable("opencode")
  if (!binary) {
    console.error("The opencode binary was not found on PATH.")
    process.exitCode = 1
    return
  }
  console.log("Adding an OpenCode Go account through OpenCode's own login flow.")
  console.log("Run this once per account. The pool discovers all of them automatically.")
  const child = spawn(binary, ["auth", "login", "opencode-go"], { stdio: "inherit" })
  const code = await new Promise<number>((resolve) => child.on("exit", (value) => resolve(value ?? 1)))
  if (code !== 0) process.exitCode = code
}

async function refresh() {
  const info = await readJson<DashboardInfo>(files.dashboard)
  if (!info?.url || !info.token) {
    console.error("No dashboard is running. Start OpenCode with the plugin installed.")
    process.exitCode = 1
    return
  }
  const response = await fetch(new URL(`/api/refresh?token=${encodeURIComponent(info.token)}`, info.url), {
    method: "POST",
  })
  if (!response.ok) {
    console.error(`Refresh failed: ${response.status}`)
    process.exitCode = 1
    return
  }
  const value = (await response.json()) as Status
  console.log(formatStatusTable(value))
}

async function openDashboard() {
  const info = await readJson<DashboardInfo>(files.dashboard)
  if (!info?.url) {
    console.error("No dashboard is running. Start OpenCode with the plugin installed.")
    process.exitCode = 1
    return
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", info.url] : [info.url]
  const child = spawn(command, args, { stdio: "ignore", detached: true })
  child.unref()
  console.log(info.url)
}

async function showInstall(args: string[]) {
  if (args.includes("--link")) {
    console.warn("--link is deprecated: OpenCode 2.2.6 does not run HTTP hooks for auto-discovered plugin directories.")
    console.warn("Use `opencode plugin add opencode-go-pool` (or the install menu) instead.")
    return
  }
  if (args.includes("--yes") || !process.stdin.isTTY) {
    await installPackage()
    return
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log("")
    console.log("OpenCode Go Pool installer")
    console.log(`Data directory: ${directory}`)
    console.log("")
    while (true) {
      console.log("1) Install the plugin into OpenCode")
      console.log("2) Uninstall the plugin")
      console.log("3) Show installation status")
      console.log("4) Quit")
      const answer = (await readline.question("> ")).trim()
      if (answer === "1") {
        await installPackage()
        continue
      }
      if (answer === "2") {
        await uninstall()
        continue
      }
      if (answer === "3") {
        await showInstallationStatus()
        continue
      }
      if (answer === "4" || answer.toLowerCase() === "q") return
      console.log("Choose 1, 2, 3 or 4.")
    }
  } finally {
    readline.close()
  }
}

async function installPackage() {
  const binary = await findExecutable("opencode")
  if (!binary) {
    console.error("The opencode binary was not found on PATH.")
    process.exitCode = 1
    return
  }
  console.log(`Installing opencode-go-pool into ${binary}...`)
  const code = await runOpencode(binary, ["plugin", "add", "opencode-go-pool"])
  if (code !== 0) {
    console.error("Installation failed. The package must be published to npm first.")
    console.error("For a local checkout, add its absolute directory to the global config's `plugins` array.")
    process.exitCode = code
    return
  }
  console.log("Installed. Restart OpenCode to load the plugin and /gopool.")
}

async function uninstall() {
  const binary = await findExecutable("opencode")
  const root = packageRoot().replace(/[\\/]+$/, "")
  if (binary) {
    for (const target of ["opencode-go-pool", root]) {
      await runOpencode(binary, ["plugin", "remove", target], true)
    }
  }
  await unlink(join(configDirectory(), "plugin", "opencode-go-pool")).catch(() => {})
  if (await pluginEntryRemains(root)) {
    console.error("The plugin entry is still present in the OpenCode config.")
    console.error(`Remove ${root} or opencode-go-pool from ${join(configDirectory(), "opencode.jsonc")} manually.`)
    process.exitCode = 1
    return
  }
  console.log("Plugin entry removed. Restart OpenCode to unload it.")
  console.log(`Local usage data is kept at: ${directory}`)
  console.log("Delete that directory manually if you also want to remove the history.")
}

async function pluginEntryRemains(root: string) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const text = await readFile(join(configDirectory(), name), "utf8").catch(() => "")
    if (text.includes(root) || text.includes("opencode-go-pool")) return true
  }
  return false
}

async function showInstallationStatus() {
  const binary = await findExecutable("opencode")
  if (binary) await runOpencode(binary, ["plugin", "list"])
  else console.log("The opencode binary was not found on PATH.")
  console.log(`Data directory: ${directory}`)
}

async function runOpencode(binary: string, args: string[], quiet = false) {
  const child = spawn(binary, args, { stdio: quiet ? "ignore" : "inherit" })
  return new Promise<number>((resolve) => child.on("exit", (value) => resolve(value ?? 1)))
}

function packageRoot() {
  return fileURLToPath(new URL("..", import.meta.url))
}

async function printURL() {
  const info = await readJson<DashboardInfo>(files.dashboard)
  if (!info?.url) {
    console.error("No dashboard is running. Start OpenCode with the plugin installed.")
    process.exitCode = 1
    return
  }
  console.log(info.url)
}

async function ownerCommand(args: string[]) {
  if (args.length === 0) {
    console.log(await resolveOwner(directory))
    return
  }
  const name = await setOwner(directory, args.join(" "))
  console.log(`Owner set to: ${name}`)
}

async function clear(args: string[]) {
  const filter: ClearFilter = {}
  let yes = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--all") filter.all = true
    else if (argument === "--yes" || argument === "-y") yes = true
    else if (argument === "--owner") filter.owner = args[++index]
    else if (argument === "--account") filter.accountID = await resolveAccount(args[++index])
    else if (argument === "--today") filter.day = new Date().toISOString().slice(0, 10)
    else if (argument === "--month") filter.month = args[++index]
    else if (argument?.startsWith("--month=")) filter.month = argument.slice("--month=".length)
    else if (argument?.startsWith("--owner=")) filter.owner = argument.slice("--owner=".length)
    else if (argument?.startsWith("--account=")) filter.accountID = await resolveAccount(argument.slice("--account=".length))
    else {
      console.error(`Unknown option: ${argument}`)
      process.exitCode = 1
      return
    }
  }
  if (!filter.all && !filter.owner && !filter.accountID && !filter.day && !filter.month) {
    filter.all = true
  }
  const scope = describeFilter(filter)
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(`Refusing to clear without confirmation. Re-run with --yes to clear: ${scope}`)
      process.exitCode = 1
      return
    }
    const answer = await confirm(`Delete local usage (${scope})? Account quota is not affected. [y/N] `)
    if (!answer) {
      console.log("Cancelled.")
      return
    }
  }

  const dashboard = await readJson<DashboardInfo>(files.dashboard)
  if (dashboard?.url && dashboard.token) {
    const response = await fetch(new URL(`/api/clear?token=${encodeURIComponent(dashboard.token)}`, dashboard.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...filter, confirm: true }),
    })
    const body = (await response.json()) as { removed?: number; status?: Status; error?: string }
    if (!response.ok) {
      console.error(body.error ?? `Clear failed: ${response.status}`)
      process.exitCode = 1
      return
    }
    console.log(`Cleared ${body.removed ?? 0} local entry(ies).`)
    if (body.status) console.log(formatStatusTable(body.status))
    return
  }

  const result = await clearUsage(files.events, filter)
  await writeJsonAtomic(files.clearRequest, { at: Date.now() }, 0o600)
  console.log(`Cleared ${result.removed} local entry(ies).`)
  console.log("OpenCode will rebuild its status on the next activity.")
}

async function exportUsage(args: string[]) {
  const filter: ClearFilter = {}
  let csv = false
  let out: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--csv") csv = true
    else if (argument === "--json") csv = false
    else if (argument === "--out") out = args[++index]
    else if (argument === "--owner") filter.owner = args[++index]
    else if (argument === "--month") filter.month = args[++index]
    else if (argument?.startsWith("--out=")) out = argument.slice("--out=".length)
    else if (argument?.startsWith("--owner=")) filter.owner = argument.slice("--owner=".length)
    else if (argument?.startsWith("--month=")) filter.month = argument.slice("--month=".length)
    else {
      console.error(`Unknown option: ${argument}`)
      process.exitCode = 1
      return
    }
  }
  if (!filter.owner && !filter.month) filter.all = true
  const entries = await readUsageEntries(files.events, filter)
  const text = csv ? toCSV(entries) : JSON.stringify(entries, null, 2)
  if (out) {
    await writeFile(out, text + (csv ? "\n" : ""), { mode: 0o600 })
    console.log(`Wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to ${out}`)
    return
  }
  console.log(text)
}

async function resolveAccount(selector: string | undefined) {
  if (!selector) return selector
  const status = await readStatus()
  if (/^\d+$/.test(selector)) {
    const indexed = status?.accounts[Number(selector) - 1]
    if (indexed) return indexed.id
  }
  const account = status?.accounts.find((item) => item.id === selector || item.label === selector)
  return account?.id ?? selector
}

function describeFilter(filter: ClearFilter) {
  if (filter.all) return "all owners and accounts"
  const parts = [
    filter.owner ? `owner ${filter.owner}` : undefined,
    filter.accountID ? `account ${filter.accountID}` : undefined,
    filter.day ? `day ${filter.day}` : undefined,
    filter.month ? `month ${filter.month}` : undefined,
  ].filter((value): value is string => value !== undefined)
  return parts.join(", ") || "all usage on this PC"
}

async function confirm(question: string) {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question(question)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

function toCSV(entries: UsageEntry[]) {
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
    "sessionID",
  ]
  const rows = entries.map((entry) =>
    [
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
      entry.sessionID,
    ]
      .map((value) => csvCell(value))
      .join(","),
  )
  return [header.join(","), ...rows].join("\n")
}

function csvCell(value: unknown) {
  const text = String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function readStatus() {
  try {
    return JSON.parse(await readFile(files.status, "utf8")) as Status
  } catch {
    return undefined
  }
}

async function findExecutable(name: string) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      try {
        await access(candidate)
        return candidate
      } catch {}
    }
  }
  return undefined
}

function help() {
  console.log(`opencode-go-pool — multi-account quota and spend for OpenCode Go

Usage:
  opencode-go-pool status [--json]     Show accounts, quota and spend
  opencode-go-pool accounts           List discovered accounts
  opencode-go-pool use <n|id|label>   Make an account active
  opencode-go-pool add                Add an account through OpenCode login
  opencode-go-pool refresh            Refresh quota through the running dashboard
  opencode-go-pool owner [name]       Show or set this machine's owner label
  opencode-go-pool clear [options]    Delete local usage (account/day/month/all)
  opencode-go-pool export [options]   Export local usage as JSON or CSV
  opencode-go-pool open               Open the dashboard in a browser
  opencode-go-pool url                Print the dashboard URL
  opencode-go-pool install            Interactive install menu
  opencode-go-pool install --yes      Install without the menu
  opencode-go-pool uninstall          Remove the plugin entry

Clear options:
  --owner <name>   only this owner (legacy metadata)
  --account <n>    only this account
  --today          only today
  --month YYYY-MM  only this month
  --all            every local usage entry
  --yes            skip confirmation

Export options:
  --owner <name>   only this owner
  --month YYYY-MM  only this month
  --csv            CSV instead of JSON
  --out <file>     write to a file

Environment:
  OPENCODE_GO_POOL_DIR                Override the data directory
                                      (default: ~/.local/share/opencode-go-pool)`)
}

void main()
