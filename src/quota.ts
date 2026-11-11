import type { Account, QuotaCache, QuotaSnapshot, QuotaWindow } from "./types"

const WINDOWS = ["rolling", "weekly", "monthly"] as const

export interface QuotaOptions {
  usageURL: string
  timeoutMs: number
}

export async function fetchQuota(account: Account, options: QuotaOptions): Promise<QuotaSnapshot> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${account.token}`,
    accept: "application/json",
    "user-agent": "opencode-go-pool/0.1",
  }
  if (account.orgID) {
    headers["x-opencode-org-id"] = account.orgID
    headers["x-org-id"] = account.orgID
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(options.usageURL, { headers, signal: controller.signal })
    if (response.status === 401) return { fetchedAt: Date.now(), error: "key rejected (401)" }
    if (response.status === 403) return { fetchedAt: Date.now(), error: "no Go subscription (403)" }
    if (!response.ok) return { fetchedAt: Date.now(), error: `usage request failed (${response.status})` }
    const body = (await response.json()) as unknown
    return parseQuota(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { fetchedAt: Date.now(), error: `usage request failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

export function parseQuota(body: unknown): QuotaSnapshot {
  const usage = (body as { usage?: unknown } | null)?.usage
  if (!usage || typeof usage !== "object") return { fetchedAt: Date.now(), error: "usage response has no usage object" }
  const snapshot: QuotaSnapshot = { fetchedAt: Date.now() }
  for (const name of WINDOWS) {
    const raw = (usage as Record<string, unknown>)[name]
    if (!raw || typeof raw !== "object") continue
    snapshot[name] = parseWindow(raw)
  }
  if (!snapshot.rolling && !snapshot.weekly && !snapshot.monthly) {
    return { fetchedAt: Date.now(), error: "usage response has no windows" }
  }
  return snapshot
}

function parseWindow(raw: object): QuotaWindow {
  const value = raw as Record<string, unknown>
  const percent = typeof value.percent === "number" && Number.isFinite(value.percent) ? value.percent : 0
  const status = typeof value.status === "string" ? value.status : "unknown"
  const resetsAt = parseTime(value.resetsAt)
  return {
    percent,
    status,
    limited: status === "rate-limited" || percent >= 100,
    resetsAt,
  }
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function loadQuotaCache(value: QuotaCache | undefined): QuotaCache {
  if (!value || value.version !== 1 || typeof value.accounts !== "object") return { version: 1, accounts: {} }
  return value
}

export function quotaFresh(snapshot: QuotaSnapshot | undefined, refreshSeconds: number, now = Date.now()) {
  return snapshot !== undefined && now - snapshot.fetchedAt < refreshSeconds * 1000
}

export function windows(snapshot: QuotaSnapshot | undefined): QuotaWindow[] {
  if (!snapshot) return []
  return WINDOWS.flatMap((name) => {
    const value = snapshot[name]
    return value ? [value] : []
  })
}

export function isExhausted(snapshot: QuotaSnapshot | undefined, threshold: number, now = Date.now()) {
  if (!snapshot || snapshot.error) return false
  for (const window of windows(snapshot)) {
    if (window.resetsAt !== null && window.resetsAt <= now) continue
    if (window.limited) return true
    if (window.percent >= threshold) return true
  }
  return false
}

export function nextReset(snapshot: QuotaSnapshot | undefined, now = Date.now()): number | null {
  const resets = windows(snapshot)
    .map((window) => window.resetsAt)
    .filter((value): value is number => value !== null && value > now)
  return resets.length === 0 ? null : Math.min(...resets)
}

export function limitingReset(snapshot: QuotaSnapshot | undefined, now = Date.now()): number | null {
  if (!snapshot) return null
  const resets = windows(snapshot)
    .filter((window) => window.limited || window.percent >= 100)
    .map((window) => window.resetsAt)
    .filter((value): value is number => value !== null && value > now)
  return resets.length === 0 ? null : Math.max(...resets)
}

export function inCooldown(cooldownUntil: number | undefined, now = Date.now()) {
  return cooldownUntil !== undefined && cooldownUntil > now
}
