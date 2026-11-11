import { readdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { ClearFilter, UsageEntry } from "./types"

export interface ClearResult {
  removed: number
  matched: number
}

export function matchesFilter(entry: UsageEntry, filter: ClearFilter) {
  if (filter.all) return true
  if (filter.owner !== undefined && entry.owner !== filter.owner) return false
  if (filter.accountID !== undefined && entry.accountID !== filter.accountID) return false
  if (filter.day !== undefined && entry.day !== filter.day) return false
  if (filter.month !== undefined && !entry.day.startsWith(filter.month)) return false
  return (
    filter.owner !== undefined ||
    filter.accountID !== undefined ||
    filter.day !== undefined ||
    filter.month !== undefined
  )
}

export async function readUsageEntries(directory: string, filter: ClearFilter = {}): Promise<UsageEntry[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const entries: UsageEntry[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as UsageEntry
      if (filter.all || matchesFilter(entry, filter)) entries.push(entry)
    } catch {}
  }
  return entries.sort((left, right) => left.ts - right.ts)
}

export async function clearUsage(directory: string, filter: ClearFilter): Promise<ClearResult> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return { removed: 0, matched: 0 }
  }
  let removed = 0
  let matched = 0
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as UsageEntry
      if (!matchesFilter(entry, filter)) continue
      matched += 1
      await unlink(join(directory, name))
      removed += 1
    } catch {}
  }
  return { removed, matched }
}
