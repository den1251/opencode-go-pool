import type { Account, AccountState, CooldownCache, QuotaCache, QuotaSnapshot } from "./types"
import { inCooldown, isExhausted, nextReset } from "./quota"
import { orderedAccounts } from "./state-store"

export interface SelectInput {
  accounts: Account[]
  state: AccountState
  quotas: QuotaCache
  cooldowns: CooldownCache
  threshold: number
  exclude?: ReadonlySet<string>
  now?: number
  ensureQuota?: (account: Account) => Promise<QuotaSnapshot | undefined>
}

export interface SelectResult {
  account: Account | undefined
  previousID: string | undefined
  changed: boolean
  reason: "active" | "quota" | "cooldown" | "fallback" | "exhausted"
  nextReset: number | null
}

export function accountUsable(
  accountID: string,
  state: AccountState,
  quotas: QuotaCache,
  cooldowns: CooldownCache,
  threshold: number,
  now = Date.now(),
) {
  if (state.disabled.includes(accountID)) return false
  if (inCooldown(cooldowns.accounts[accountID], now)) return false
  const snapshot = quotas.accounts[accountID]
  if (snapshot?.error && /(401|403)/.test(snapshot.error)) return false
  return !isExhausted(snapshot, threshold, now)
}

export async function selectAccount(input: SelectInput): Promise<SelectResult> {
  const now = input.now ?? Date.now()
  const ordered = orderedAccounts(input.accounts, input.state)
  const candidates = ordered.filter(
    (account) => !input.exclude?.has(account.id) && !input.state.disabled.includes(account.id),
  )
  const previousID = input.state.activeID
  const active = candidates.find((account) => account.id === previousID)

  if (active) {
    const quota = (await input.ensureQuota?.(active)) ?? input.quotas.accounts[active.id]
    if (quota) input.quotas.accounts[active.id] = quota
    if (accountUsable(active.id, input.state, input.quotas, input.cooldowns, input.threshold, now)) {
      return { account: active, previousID, changed: false, reason: "active", nextReset: null }
    }
  }

  let earliest: number | null = null
  for (const account of candidates) {
    if (account.id === active?.id) continue
    const quota = (await input.ensureQuota?.(account)) ?? input.quotas.accounts[account.id]
    if (quota) input.quotas.accounts[account.id] = quota
    if (accountUsable(account.id, input.state, input.quotas, input.cooldowns, input.threshold, now)) {
      const reason = inCooldown(input.cooldowns.accounts[account.id], now) ? "cooldown" : "quota"
      return {
        account,
        previousID,
        changed: account.id !== previousID,
        reason: active ? reason : "fallback",
        nextReset: null,
      }
    }
    const reset = nextReset(quota, now)
    if (reset !== null && (earliest === null || reset < earliest)) earliest = reset
  }

  if (active) {
    const reset = nextReset(input.quotas.accounts[active.id], now)
    if (reset !== null && (earliest === null || reset < earliest)) earliest = reset
  }
  return { account: undefined, previousID, changed: false, reason: "exhausted", nextReset: earliest }
}
