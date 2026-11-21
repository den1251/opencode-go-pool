export type WindowName = "rolling" | "weekly" | "monthly"

export interface QuotaWindow {
  percent: number
  limited: boolean
  status: string
  resetsAt: number | null
}

export interface QuotaSnapshot {
  fetchedAt: number
  rolling?: QuotaWindow
  weekly?: QuotaWindow
  monthly?: QuotaWindow
  error?: string
}

export interface QuotaCache {
  version: 1
  accounts: Record<string, QuotaSnapshot>
}

export interface CooldownCache {
  version: 1
  accounts: Record<string, number>
}

export type AccountMethod = "key" | "oauth"

export interface Account {
  id: string
  label: string
  method: AccountMethod
  token: string
  orgID?: string
  expires?: number
  keyHint: string
  source: "credential" | "env"
}

export interface AccountState {
  version: 1
  order: string[]
  disabled: string[]
  activeID?: string
  updatedAt: number
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageEntry {
  id: string
  ts: number
  day: string
  owner: string
  machineID: string
  accountID: string
  accountLabel: string
  providerID: string
  model: string
  modelName?: string
  source: string
  cost: number
  estimated: boolean
  tokens: Tokens
  sessionID: string
  listCost?: number
  allowance?: number
  charged?: number
  billingSource?: string
  metering?: "response" | "event" | "estimate"
}

export interface ModelUsage extends Tokens {
  providerID: string
  model: string
  modelName?: string
  requests: number
  cost: number
  listCost: number
  allowance: number
}

export interface AccountUsage {
  requests: number
  cost: number
  tokens: Tokens
  listCost: number
  allowance: number
  charged: number
}

export interface Aggregate {
  since: number
  entries: number
  estimated: number
  cost: number
  listCost: number
  allowance: number
  charged: number
  tokens: Tokens
  models: ModelUsage[]
  accounts: Record<string, AccountUsage>
  owners: Record<string, AccountUsage>
  billing: Record<string, number>
}

export interface AccountStatus {
  id: string
  label: string
  keyHint: string
  method: AccountMethod
  active: boolean
  usable: boolean
  disabled: boolean
  cooldownUntil: number | null
  quota: QuotaSnapshot | null
  today: { cost: number; tokens: Tokens; allowance: number }
  month: { cost: number; tokens: Tokens; allowance: number }
}

export interface SwitchEntry {
  ts: number
  from: string | null
  to: string
  reason: string
}

export interface Status {
  version: 1
  generatedAt: number
  dataDir: string
  owner: string
  machineID: string
  activeID: string | null
  accounts: AccountStatus[]
  today: Aggregate
  month: Aggregate
  switches: SwitchEntry[]
  dashboard?: { url: string; port: number } | undefined
  lastError?: string | undefined
}

export interface DashboardInfo {
  url: string
  port: number
  token: string
  pid: number
}

export interface ClearFilter {
  owner?: string
  accountID?: string
  day?: string
  month?: string
  all?: boolean
}

export interface PluginOptions {
  dataDir?: string
  owner?: string
  switchAtPercent?: number
  refreshSeconds?: number
  dashboard?: boolean
  dashboardPort?: number
  usageURL?: string
  upstream?: string
  requestTimeoutMs?: number
  debug?: boolean
}
