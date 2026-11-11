import { describe, expect, test } from "bun:test"
import type { AccountState, CooldownCache, QuotaCache } from "../src/types"
import { account } from "./helpers"
import { accountUsable, selectAccount } from "../src/selection"

const accounts = [
  account({ id: "a", label: "A" }),
  account({ id: "b", label: "B", token: "oc_sk_two_5678" }),
  account({ id: "c", label: "C", token: "oc_sk_three_9012" }),
]

function state(activeID?: string): AccountState {
  return { version: 1, order: ["a", "b", "c"], disabled: [], activeID, updatedAt: 0 }
}

function quotas(values: Record<string, { percent: number; limited?: boolean; resetsAt?: number }>): QuotaCache {
  return {
    version: 1,
    accounts: Object.fromEntries(
      Object.entries(values).map(([id, value]) => [
        id,
        {
          fetchedAt: Date.now(),
          rolling: {
            percent: value.percent,
            limited: value.limited ?? value.percent >= 100,
            status: value.limited ? "rate-limited" : "ok",
            resetsAt: value.resetsAt ?? null,
          },
        },
      ]),
    ),
  }
}

const cooldowns: CooldownCache = { version: 1, accounts: {} }

describe("accountUsable", () => {
  test("honours disabled, cooldown, quota and unknown quota", () => {
    const now = Date.now()
    expect(accountUsable("a", { ...state(), disabled: ["a"] }, quotas({}), cooldowns, 100, now)).toBe(false)
    expect(accountUsable("a", state(), quotas({}), { version: 1, accounts: { a: now + 1000 } }, 100, now)).toBe(false)
    expect(accountUsable("a", state(), quotas({ a: { percent: 100 } }), cooldowns, 100, now)).toBe(false)
    expect(accountUsable("a", state(), quotas({ a: { percent: 50 } }), cooldowns, 100, now)).toBe(true)
    expect(accountUsable("a", state(), { version: 1, accounts: {} }, cooldowns, 100, now)).toBe(true)
    expect(
      accountUsable("a", state(), { version: 1, accounts: { a: { fetchedAt: now, error: "no Go subscription (403)" } } }, cooldowns, 100, now),
    ).toBe(false)
    expect(
      accountUsable("a", state(), { version: 1, accounts: { a: { fetchedAt: now, error: "usage request failed" } } }, cooldowns, 100, now),
    ).toBe(true)
  })
})

describe("selectAccount", () => {
  test("keeps the active account when usable", async () => {
    const result = await selectAccount({
      accounts,
      state: state("b"),
      quotas: quotas({ a: { percent: 10 }, b: { percent: 20 }, c: { percent: 30 } }),
      cooldowns,
      threshold: 100,
    })
    expect(result.account?.id).toBe("b")
    expect(result.changed).toBe(false)
    expect(result.reason).toBe("active")
  })

  test("switches to the first usable account when the active is drained", async () => {
    const result = await selectAccount({
      accounts,
      state: state("a"),
      quotas: quotas({ a: { percent: 100 }, b: { percent: 20 }, c: { percent: 30 } }),
      cooldowns,
      threshold: 100,
    })
    expect(result.account?.id).toBe("b")
    expect(result.changed).toBe(true)
    expect(result.reason).toBe("quota")
  })

  test("skips a cooling account", async () => {
    const result = await selectAccount({
      accounts,
      state: state("a"),
      quotas: quotas({ a: { percent: 100 }, b: { percent: 20 } }),
      cooldowns: { version: 1, accounts: { a: Date.now() + 60_000, b: Date.now() + 60_000 } },
      threshold: 100,
    })
    expect(result.account?.id).toBe("c")
  })

  test("respects exclusions during failover", async () => {
    const result = await selectAccount({
      accounts,
      state: state("a"),
      quotas: quotas({}),
      cooldowns,
      threshold: 100,
      exclude: new Set(["a"]),
    })
    expect(result.account?.id).toBe("b")
    expect(result.reason).toBe("fallback")
  })

  test("returns exhausted with the earliest reset", async () => {
    const now = Date.now()
    const result = await selectAccount({
      accounts,
      state: state("a"),
      quotas: quotas({
        a: { percent: 100, resetsAt: now + 5000 },
        b: { percent: 100, resetsAt: now + 1000 },
        c: { percent: 100, resetsAt: now + 2000 },
      }),
      cooldowns,
      threshold: 100,
      now,
    })
    expect(result.account).toBeUndefined()
    expect(result.reason).toBe("exhausted")
    expect(result.nextReset).toBe(now + 1000)
  })

  test("uses an explicit ensureQuota hook", async () => {
    const result = await selectAccount({
      accounts,
      state: state("a"),
      quotas: quotas({}),
      cooldowns,
      threshold: 100,
      ensureQuota: async (value) =>
        value.id === "a"
          ? { fetchedAt: Date.now(), rolling: { percent: 100, limited: true, status: "rate-limited", resetsAt: null } }
          : undefined,
    })
    expect(result.account?.id).toBe("b")
  })
})
