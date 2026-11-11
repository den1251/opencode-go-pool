import type {
  Account,
  AccountState,
  AccountStatus,
  Aggregate,
  CooldownCache,
  QuotaCache,
  Status,
  SwitchEntry,
  Tokens,
} from "./types"
import { accountUsable } from "./selection"
import { readJson, writeJsonAtomic } from "./fs-utils"
import { emptyUsage } from "./ledger"

export interface StatusInput {
  dataDir: string
  owner: string
  machineID: string
  accounts: Account[]
  state: AccountState
  quotas: QuotaCache
  cooldowns: CooldownCache
  today: Aggregate
  month: Aggregate
  switches: SwitchEntry[]
  dashboard?: { url: string; port: number }
  threshold: number
  lastError?: string
}

export function buildStatus(input: StatusInput): Status {
  const now = Date.now()
  const accounts: AccountStatus[] = input.state.order.flatMap((id) => {
    const account = input.accounts.find((item) => item.id === id)
    if (!account) return []
    const today = input.today.accounts[id] ?? emptyUsage()
    const month = input.month.accounts[id] ?? emptyUsage()
    const cooldownUntil = input.cooldowns.accounts[id] ?? null
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
        month: { cost: month.cost, tokens: month.tokens, allowance: month.allowance },
      },
    ]
  })

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
    ...(input.dashboard ? { dashboard: input.dashboard } : {}),
    ...(input.lastError ? { lastError: input.lastError } : {}),
  }
}

export async function readStatus(file: string): Promise<Status | undefined> {
  return readJson<Status>(file)
}

export async function writeStatus(file: string, status: Status) {
  await writeJsonAtomic(file, status, 0o600)
}

export async function readSwitches(file: string): Promise<SwitchEntry[]> {
  const value = await readJson<SwitchEntry[]>(file)
  return Array.isArray(value) ? value : []
}

export async function appendSwitch(file: string, entry: SwitchEntry) {
  const current = await readSwitches(file)
  current.push(entry)
  await writeJsonAtomic(file, current.slice(-100), 0o644)
}

export function percent(value: number | undefined) {
  if (value === undefined) return "—"
  return `${value.toFixed(1)}%`
}

export function money(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  if (value < 0.0001) return `$${trimZeros(value.toFixed(8))}`
  if (value < 0.01) return `$${value.toFixed(6)}`
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function trimZeros(value: string) {
  return value.replace(/0+$/, "").replace(/\.$/, "")
}

export function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function tokensText(tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }) {
  return `${compact(tokens.input)} in / ${compact(tokens.output)} out`
}

function planText(allowance: number) {
  return allowance > 0 ? `${money(allowance)} plan` : "plan n/a"
}

export function formatStatusTable(status: Status): string {
  const lines: string[] = []
  lines.push(`OpenCode Go Pool — ${status.accounts.length} account${status.accounts.length === 1 ? "" : "s"}`)
  lines.push("")
  const widths = [2, 22, 12, 20, 20, 20, 10, 10, 10]
  const row = (cells: string[]) =>
    cells.map((value, index) => truncate(value, widths[index]!).padEnd(widths[index]!)).join("  ").trimEnd()
  lines.push(row(["#", "Account", "Key", "5h", "Week", "Month", "Today", "Month $", "Plan $"]))
  status.accounts.forEach((account, index) => {
    const mark = account.active ? "*" : account.usable ? " " : "x"
    lines.push(
      row([
        `${mark}${index + 1}`,
        account.label,
        account.keyHint,
        quotaCell(account.quota?.rolling),
        quotaCell(account.quota?.weekly),
        quotaCell(account.quota?.monthly),
        money(account.today.cost),
        money(account.month.cost),
        account.month.allowance > 0 ? money(account.month.allowance) : "—",
      ]),
    )
  })
  lines.push("")
  const totals = `This machine: ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${tokensText(status.month.tokens)} · ${status.month.entries} request(s)`
  if (sameTotals(status.today, status.month)) {
    lines.push(totals)
  } else {
    lines.push(
      `Today: ${money(status.today.cost)} list · ${planText(status.today.allowance)} · ${tokensText(status.today.tokens)} · ${status.today.entries} request(s)`,
    )
    lines.push(
      `This month: ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${tokensText(status.month.tokens)} · ${status.month.entries} request(s)`,
    )
  }
  if (status.month.estimated > 0) {
    lines.push(`Cost includes catalog estimates for ${status.month.estimated} request(s) without an exact list cost.`)
  }
  if (status.dashboard) lines.push(`Dashboard: ${status.dashboard.url}`)
  lines.push(`Machine: ${status.machineID}`)
  if (status.lastError) lines.push(`Last error: ${status.lastError}`)
  const last = status.switches[0]
  if (last) lines.push(`Last switch: ${last.from ?? "none"} → ${last.to} (${last.reason})`)
  return lines.join("\n")
}

function sameTotals(left: { entries: number; cost: number; allowance: number; tokens: Tokens }, right: { entries: number; cost: number; allowance: number; tokens: Tokens }) {
  return (
    left.entries === right.entries &&
    left.cost === right.cost &&
    left.allowance === right.allowance &&
    left.tokens.input === right.tokens.input &&
    left.tokens.output === right.tokens.output &&
    left.tokens.reasoning === right.tokens.reasoning &&
    left.tokens.cacheRead === right.tokens.cacheRead &&
    left.tokens.cacheWrite === right.tokens.cacheWrite
  )
}

function quotaCell(value: { percent: number; limited: boolean; resetsAt: number | null } | undefined) {
  if (!value) return "—"
  const reset = value.resetsAt ? ` (${resetText(value.resetsAt)})` : ""
  return `${value.limited ? "LIMIT " : ""}${value.percent.toFixed(1)}%${reset}`
}

function resetText(ts: number) {
  const seconds = Math.max(0, Math.round((ts - Date.now()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`
  return `${(seconds / 86_400).toFixed(1)}d`
}

function truncate(value: string, length: number) {
  return value.length <= length ? value : value.slice(0, length - 1) + "…"
}
