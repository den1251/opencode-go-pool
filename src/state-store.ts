import type { Account, AccountState } from "./types"
import { readJson, withLock, writeJsonAtomic } from "./fs-utils"

export async function loadAccountState(file: string): Promise<AccountState | undefined> {
  const value = await readJson<AccountState>(file)
  if (!value || value.version !== 1) return undefined
  return value
}

export async function reconcileAccounts(file: string, directory: string, accounts: Account[]): Promise<AccountState> {
  return withLock(directory, "accounts", async () => {
    const current = await loadAccountState(file)
    const available = new Set(accounts.map((account) => account.id))
    const order = (current?.order ?? []).filter((id) => available.has(id))
    for (const account of accounts) if (!order.includes(account.id)) order.push(account.id)

    const disabled = (current?.disabled ?? []).filter((id) => available.has(id))
    const activeID =
      current?.activeID && available.has(current.activeID) && !disabled.includes(current.activeID)
        ? current.activeID
        : order.find((id) => !disabled.includes(id))

    const next: AccountState = {
      version: 1,
      order,
      disabled,
      ...(activeID ? { activeID } : {}),
      updatedAt: Date.now(),
    }
    const same =
      current !== undefined &&
      current.activeID === next.activeID &&
      current.order.length === next.order.length &&
      current.order.every((id, index) => next.order[index] === id) &&
      current.disabled.length === next.disabled.length &&
      current.disabled.every((id, index) => next.disabled[index] === id)
    if (!same) await writeJsonAtomic(file, next)
    return next
  })
}

export async function setActiveAccount(
  file: string,
  directory: string,
  activeID: string,
): Promise<AccountState> {
  return withLock(directory, "accounts", async () => {
    const current = (await loadAccountState(file)) ?? { version: 1 as const, order: [], disabled: [], updatedAt: 0 }
    const next: AccountState = { ...current, activeID, updatedAt: Date.now() }
    await writeJsonAtomic(file, next)
    return next
  })
}

export function orderedAccounts(accounts: Account[], state: AccountState): Account[] {
  const byID = new Map(accounts.map((account) => [account.id, account]))
  const ordered = state.order.flatMap((id) => {
    const account = byID.get(id)
    return account ? [account] : []
  })
  for (const account of accounts) if (!ordered.some((item) => item.id === account.id)) ordered.push(account)
  return ordered
}

export function isDisabled(state: AccountState, accountID: string) {
  return state.disabled.includes(accountID)
}
