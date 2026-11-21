import type { AccountStatus, ModelUsage, QuotaWindow, Status } from "./types"

export function compact(value: number) {
  if (!Number.isFinite(value)) return "0"
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

export function money(value: number) {
  if (!Number.isFinite(value) || value === 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function percent(window: QuotaWindow | undefined) {
  return window ? `${Math.round(window.percent)}%` : "—"
}

export function quotaLine(account: AccountStatus | undefined) {
  if (!account) return "no account"
  const quota = account.quota
  return `5h ${percent(quota?.rolling)} · week ${percent(quota?.weekly)} · month ${percent(quota?.monthly)}`
}

export function activeAccount(status: Status | undefined) {
  return status?.accounts.find((account) => account.active) ?? status?.accounts[0]
}

export function quotaTone(status: Status | undefined): "success" | "warning" | "danger" | undefined {
  const account = activeAccount(status)
  if (!account?.quota) return undefined
  const values = [account.quota.rolling?.percent, account.quota.weekly?.percent, account.quota.monthly?.percent]
    .filter((value): value is number => typeof value === "number")
  if (values.length === 0) return undefined
  const highest = Math.max(...values)
  if (highest >= 100) return "danger"
  if (highest >= 90) return "warning"
  return undefined
}

export function planValue(value: number) {
  return value > 0 ? money(value) : "plan n/a"
}

function planText(value: number) {
  return value > 0 ? `plan ${money(value)}` : "plan n/a"
}

export function modelLine(model: ModelUsage) {
  const name = (model.modelName ?? model.model).padEnd(24).slice(0, 24)
  return `${name} ${String(model.requests).padStart(7)} ${money(model.cost).padStart(9)} ${money(model.allowance).padStart(9)}`
}

function modelHeader() {
  return `${"Model".padEnd(24)} ${"Req".padStart(7)} ${"List $".padStart(9)} ${"Plan $".padStart(9)}`
}

export function usageLines(status: Status | undefined) {
  if (!status) return ["Loading OpenCode Go usage…"]
  const account = activeAccount(status)
  const lines = [
    `OpenCode Go Pool — ${status.accounts.length} account(s)`,
    `Active: ${account ? `${account.label} (${account.keyHint})` : "none"}`,
    `Quota: ${quotaLine(account)}`,
    `Today: ${money(status.today.cost)} list · ${planText(status.today.allowance)} · ${status.today.entries} request(s)`,
    `Month: ${money(status.month.cost)} list · ${planText(status.month.allowance)} · ${status.month.entries} request(s)`,
  ]

  if (status.today.models.length > 0) {
    lines.push("", "Models today", modelHeader())
    for (const model of status.today.models) lines.push(modelLine(model))
  }
  if (status.month.models.length > 0) {
    lines.push("", "Models this month", modelHeader())
    for (const model of status.month.models) lines.push(modelLine(model))
  }
  if (status.month.estimated > 0) {
    lines.push("", `Cost includes catalog estimates for ${status.month.estimated} request(s).`)
  }
  return lines
}
