import { afterEach, describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { Aggregate, UsageEntry } from "../src/types"
import { aggregateUsage, applyEntry, dayKey, monthKey, normalizeTokens, pruneUsage, recordUsage } from "../src/ledger"
import { clearUsage, matchesFilter, readUsageEntries } from "../src/clear"
import { aggregate, cleanup, tempDir, tokens } from "./helpers"

const dirs: string[] = []
async function directory() {
  const value = await tempDir("ledger")
  dirs.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  const ts = overrides.ts ?? Date.parse("2026-11-10T10:00:00.000Z")
  return {
    id: "evt_1",
    ts,
    day: dayKey(ts),
    owner: "alice",
    machineID: "mch_test",
    accountID: "a",
    accountLabel: "A",
    providerID: "opencode-go",
    model: "deepseek-v4",
    source: "step",
    cost: 0.5,
    estimated: false,
    tokens: tokens({ input: 100, output: 20 }),
    sessionID: "ses_1",
    ...overrides,
  }
}

describe("ledger", () => {
  test("normalises token shapes", () => {
    expect(normalizeTokens({ input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } })).toEqual({
      input: 2,
      output: 3,
      reasoning: 4,
      cacheRead: 5,
      cacheWrite: 6,
    })
    expect(normalizeTokens(undefined)).toEqual(tokens())
    expect(normalizeTokens({ input: -1, output: "x" })).toEqual(tokens())
  })

  test("deduplicates events by id", async () => {
    const dir = await directory()
    expect(await recordUsage(dir, entry())).toBe(true)
    expect(await recordUsage(dir, entry())).toBe(false)
    const names = await readdir(dir)
    expect(names.length).toBe(1)
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false)
  })

  test("aggregates models, accounts and owners for a month", async () => {
    const dir = await directory()
    await recordUsage(dir, entry({ id: "evt_1" }))
    await recordUsage(
      dir,
      entry({
        id: "evt_2",
        owner: "bob",
        accountID: "b",
        accountLabel: "B",
        model: "other",
        cost: 1.5,
        tokens: tokens({ input: 10, output: 2 }),
        ts: Date.parse("2026-11-11T10:00:00.000Z"),
      }),
    )
    await recordUsage(
      dir,
      entry({ id: "evt_3", ts: Date.parse("2026-10-01T10:00:00.000Z"), cost: 99 }),
    )
    const month = await aggregateUsage(dir, { month: "2026-11" })
    expect(month.entries).toBe(2)
    expect(month.cost).toBe(2)
    expect(month.tokens.input).toBe(110)
    expect(month.accounts.a?.cost).toBe(0.5)
    expect(month.accounts.b?.cost).toBe(1.5)
    expect(month.owners.alice?.cost).toBe(0.5)
    expect(month.owners.bob?.cost).toBe(1.5)
    expect(month.models[0]?.model).toBe("other")
  })

  test("keeps model display names alongside model IDs", async () => {
    const dir = await directory()
    await recordUsage(dir, entry({ id: "evt_1" }))
    await recordUsage(dir, entry({ id: "evt_2", modelName: "DeepSeek V4.1 Flash 1017" }))
    await recordUsage(dir, entry({ id: "evt_3", model: "glm-5.3", modelName: "GLM-5.3" }))
    const month = await aggregateUsage(dir, { month: "2026-11" })
    const deepseek = month.models.find((model) => model.model === "deepseek-v4")
    expect(deepseek?.modelName).toBe("DeepSeek V4.1 Flash 1017")
    expect(deepseek?.requests).toBe(2)
    expect(month.models.find((model) => model.model === "glm-5.3")?.modelName).toBe("GLM-5.3")
  })

  test("aggregates a single day", async () => {
    const dir = await directory()
    await recordUsage(dir, entry({ id: "evt_1" }))
    await recordUsage(dir, entry({ id: "evt_2", ts: Date.parse("2026-11-11T10:00:00.000Z") }))
    const day = await aggregateUsage(dir, { day: "2026-11-10" })
    expect(day.entries).toBe(1)
  })

  test("returns an empty aggregate for a missing directory", async () => {
    const aggregate = await aggregateUsage(join("/tmp/opencode", "does-not-exist"), { month: "2026-11" })
    expect(aggregate.entries).toBe(0)
    expect(aggregate.models).toEqual([])
  })

  test("applyEntry sorts models", () => {
    const aggregateValue: Aggregate = aggregate()
    applyEntry(aggregateValue, entry({ id: "1", model: "cheap", cost: 0.1 }))
    applyEntry(aggregateValue, entry({ id: "2", model: "expensive", cost: 2 }))
    expect(aggregateValue.models[0]?.model).toBe("expensive")
    expect(aggregateValue.entries).toBe(2)
  })

  test("day and month keys are UTC", () => {
    expect(dayKey(Date.parse("2026-11-10T23:59:00.000Z"))).toBe("2026-11-10")
    expect(monthKey(Date.parse("2026-11-10T23:59:00.000Z"))).toBe("2026-11")
  })

  test("prunes old events", async () => {
    const dir = await directory()
    await recordUsage(dir, entry({ id: "old", ts: Date.parse("2020-01-01T00:00:00.000Z") }))
    await recordUsage(dir, entry({ id: "new" }))
    await pruneUsage(dir, 30)
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith("2020-01-01"))).toBe(false)
    expect(names.some((name) => name.startsWith("2026-11-10"))).toBe(true)
  })
})

describe("clear and export filters", () => {
  test("matches by owner, account, day, month and all", () => {
    expect(matchesFilter(entry(), {})).toBe(false)
    expect(matchesFilter(entry(), { owner: "alice" })).toBe(true)
    expect(matchesFilter(entry(), { owner: "bob" })).toBe(false)
    expect(matchesFilter(entry(), { accountID: "a" })).toBe(true)
    expect(matchesFilter(entry(), { day: "2026-11-10" })).toBe(true)
    expect(matchesFilter(entry(), { month: "2026-11" })).toBe(true)
    expect(matchesFilter(entry(), { all: true })).toBe(true)
  })

  test("reads and clears only matching events", async () => {
    const dir = await directory()
    await recordUsage(dir, entry({ id: "a1", owner: "alice" }))
    await recordUsage(dir, entry({ id: "b1", owner: "bob" }))
    expect((await readUsageEntries(dir, { owner: "alice" })).length).toBe(1)
    const result = await clearUsage(dir, { owner: "alice" })
    expect(result.removed).toBe(1)
    expect((await readUsageEntries(dir, { all: true })).length).toBe(1)
    const all = await clearUsage(dir, { all: true })
    expect(all.removed).toBe(1)
  })

  test("clearing a missing directory is a no-op", async () => {
    expect(await clearUsage(join("/tmp/opencode", "nope"), { all: true })).toEqual({ removed: 0, matched: 0 })
  })
})
