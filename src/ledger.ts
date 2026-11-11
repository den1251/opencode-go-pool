import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AccountUsage, Aggregate, Tokens, UsageEntry } from "./types"

export const EMPTY_TOKENS: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export function normalizeTokens(value: unknown): Tokens {
  const tokens = (value ?? {}) as Record<string, unknown>
  const cache = (tokens.cache ?? {}) as Record<string, unknown>
  return {
    input: number(tokens.input),
    output: number(tokens.output),
    reasoning: number(tokens.reasoning),
    cacheRead: number(cache.read),
    cacheWrite: number(cache.write),
  }
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

export function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

export function monthKey(ts: number) {
  return dayKey(ts).slice(0, 7)
}

export async function recordUsage(directory: string, entry: UsageEntry): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const safe = entry.id.replace(/[^a-zA-Z0-9_-]/g, "_")
  const file = join(directory, `${entry.day}__${safe}.json`)
  try {
    await writeFile(file, JSON.stringify(entry) + "\n", { flag: "wx", mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

export async function aggregateUsage(directory: string, options: { month?: string; day?: string } = {}): Promise<Aggregate> {
  const prefix = options.day ?? options.month ?? ""
  const since = options.day
    ? Date.parse(`${options.day}T00:00:00.000Z`)
    : options.month
      ? Date.parse(`${options.month}-01T00:00:00.000Z`)
      : 0
  const aggregate: Aggregate = {
    since,
    entries: 0,
    estimated: 0,
    cost: 0,
    listCost: 0,
    allowance: 0,
    charged: 0,
    tokens: { ...EMPTY_TOKENS },
    models: [],
    accounts: {},
    owners: {},
    billing: {},
  }

  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return aggregate
    throw error
  }

  for (const name of names) {
    if (!name.endsWith(".json") || !name.startsWith(prefix)) continue
    let entry: UsageEntry
    try {
      entry = JSON.parse(await readFile(join(directory, name), "utf8")) as UsageEntry
    } catch {
      continue
    }
    applyEntry(aggregate, entry)
  }

  return aggregate
}

function add(aggregate: Aggregate, entry: UsageEntry) {
  const listCost = entry.listCost ?? 0
  const allowance = entry.allowance ?? 0
  const charged = entry.charged ?? 0
  aggregate.entries += 1
  if (entry.estimated) aggregate.estimated += 1
  aggregate.cost += entry.cost
  aggregate.listCost += listCost
  aggregate.allowance += allowance
  aggregate.charged += charged
  addTokens(aggregate.tokens, entry.tokens)
  if (entry.billingSource) aggregate.billing[entry.billingSource] = (aggregate.billing[entry.billingSource] ?? 0) + 1

  const account = aggregate.accounts[entry.accountID] ?? emptyUsage()
  account.requests += 1
  account.cost += entry.cost
  account.listCost += listCost
  account.allowance += allowance
  account.charged += charged
  addTokens(account.tokens, entry.tokens)
  aggregate.accounts[entry.accountID] = account

  const owner = aggregate.owners[entry.owner] ?? emptyUsage()
  owner.requests += 1
  owner.cost += entry.cost
  owner.listCost += listCost
  owner.allowance += allowance
  owner.charged += charged
  addTokens(owner.tokens, entry.tokens)
  aggregate.owners[entry.owner] = owner

  const key = `${entry.providerID}/${entry.model}`
  const model = aggregate.models.find((item) => `${item.providerID}/${item.model}` === key)
  if (model) {
    model.requests += 1
    model.cost += entry.cost
    model.listCost += listCost
    model.allowance += allowance
    addTokens(model, entry.tokens)
  } else {
    aggregate.models.push({
      providerID: entry.providerID,
      model: entry.model,
      requests: 1,
      cost: entry.cost,
      listCost,
      allowance,
      ...entry.tokens,
    })
  }
}

export function emptyUsage(): AccountUsage {
  return { requests: 0, cost: 0, listCost: 0, allowance: 0, charged: 0, tokens: { ...EMPTY_TOKENS } }
}

export function applyEntry(aggregate: Aggregate, entry: UsageEntry) {
  add(aggregate, entry)
  aggregate.models.sort((left, right) => right.cost - left.cost || right.requests - left.requests)
}

export function addTokens(target: Tokens, value: Tokens) {
  target.input += value.input
  target.output += value.output
  target.reasoning += value.reasoning
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
}

export async function pruneUsage(directory: string, keepDays = 120) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const cutoffDay = dayKey(cutoff)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  for (const name of names) {
    const day = name.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoffDay) continue
    await unlink(join(directory, name)).catch(() => {})
  }
}
