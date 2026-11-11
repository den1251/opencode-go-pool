import type { CooldownCache, QuotaCache } from "./types"
import { readJson, withLock, writeJsonAtomic } from "./fs-utils"
import { loadQuotaCache } from "./quota"

export async function readQuotaCache(file: string): Promise<QuotaCache> {
  return loadQuotaCache(await readJson<QuotaCache>(file))
}

export async function writeQuotaCache(file: string, directory: string, cache: QuotaCache) {
  await withLock(directory, "quota", () => writeJsonAtomic(file, cache))
}

export async function readCooldowns(file: string): Promise<CooldownCache> {
  const value = await readJson<CooldownCache>(file)
  if (!value || value.version !== 1 || typeof value.accounts !== "object") return { version: 1, accounts: {} }
  return value
}

export async function writeCooldown(
  file: string,
  directory: string,
  accountID: string,
  until: number,
): Promise<CooldownCache> {
  return withLock(directory, "cooldown", async () => {
    const current = await readCooldowns(file)
    current.accounts[accountID] = until
    await writeJsonAtomic(file, current)
    return current
  })
}
