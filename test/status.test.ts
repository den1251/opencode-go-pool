import { describe, expect, test } from "bun:test"
import { buildStatus, compact, formatStatusTable, money, percent, tokensText } from "../src/status"
import type { AccountState, Aggregate, CooldownCache, QuotaCache } from "../src/types"
import { account, accountUsage, aggregate, modelUsage, tokens } from "./helpers"

const state: AccountState = { version: 1, order: ["a", "b"], disabled: [], activeID: "a", updatedAt: 0 }
const accounts = [account({ id: "a", label: "Account A" }), account({ id: "b", label: "Account B", token: "x" })]
const quotas: QuotaCache = {
  version: 1,
  accounts: {
    a: {
      fetchedAt: Date.now(),
      rolling: { percent: 10, limited: false, status: "ok", resetsAt: Date.now() + 60_000 },
      weekly: { percent: 20, limited: false, status: "ok", resetsAt: Date.now() + 120_000 },
      monthly: { percent: 30, limited: false, status: "ok", resetsAt: Date.now() + 240_000 },
    },
  },
}
const cooldowns: CooldownCache = { version: 1, accounts: {} }
const empty: Aggregate = aggregate()
const month: Aggregate = aggregate({
  entries: 3,
  cost: 1.5,
  listCost: 1.4,
  allowance: 0.4,
  charged: 0,
  tokens: tokens({ input: 1000, output: 200 }),
  models: [
    modelUsage({
      requests: 3,
      cost: 1.5,
      listCost: 1.4,
      allowance: 0.4,
      ...tokens({ input: 1000, output: 200 }),
    }),
  ],
  accounts: { a: accountUsage({ requests: 2, cost: 1, listCost: 0.9, allowance: 0.3, tokens: tokens({ input: 800, output: 100 }) }) },
  owners: {
    alice: accountUsage({ requests: 3, cost: 1.5, listCost: 1.4, allowance: 0.4, tokens: tokens({ input: 1000, output: 200 }) }),
    bob: accountUsage({ requests: 1, cost: 0.2, listCost: 0.1, allowance: 0.05, tokens: tokens({ input: 10 }) }),
  },
})

describe("status", () => {
  test("builds account status with quota and spend", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas,
      cooldowns,
      today: empty,
      month,
      switches: [{ ts: 1, from: "B", to: "A", reason: "quota" }],
      threshold: 100,
    })
    expect(status.owner).toBe("alice")
    expect(status.activeID).toBe("a")
    expect(status.accounts[0]?.active).toBe(true)
    expect(status.accounts[0]?.usable).toBe(true)
    expect(status.accounts[1]?.quota).toBeNull()
    expect(status.month.owners.bob?.cost).toBe(0.2)
    expect(status.switches[0]?.to).toBe("A")
  })

  test("marks an exhausted account unusable", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas: {
        version: 1,
        accounts: {
          a: { fetchedAt: Date.now(), error: "oops" },
          b: { fetchedAt: Date.now(), rolling: { percent: 100, limited: true, status: "rate-limited", resetsAt: null } },
        },
      },
      cooldowns,
      today: empty,
      month: empty,
      switches: [],
      threshold: 100,
    })
    expect(status.accounts[0]?.usable).toBe(true)
    expect(status.accounts[1]?.usable).toBe(false)
  })

  test("formats a table with owner and quotas", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas,
      cooldowns,
      today: empty,
      month,
      switches: [],
      threshold: 100,
      dashboard: { url: "http://127.0.0.1:1/?token=x", port: 1 },
    })
    const text = formatStatusTable(status)
    expect(text).toContain("OpenCode Go Pool")
    expect(text).toContain("Account A")
    expect(text).toContain("10.0%")
    expect(text).toContain("Today:")
    expect(text).toContain("This month:")
    expect(text).toContain("$0.4000 plan")
    expect(text).toContain("Models this month")
    expect(text).toContain("deepseek-v4")
    expect(text).toContain("Dashboard:")
  })

  test("lists different models separately for today and month", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas,
      cooldowns,
      today: aggregate({
        entries: 1,
        models: [modelUsage({ model: "glm-5.3", requests: 1, cost: 0.02, allowance: 0.01 })],
      }),
      month: aggregate({
        entries: 3,
        models: [
          modelUsage({ model: "deepseek-v4", requests: 1, cost: 0.5, allowance: 0.4 }),
          modelUsage({ model: "glm-5.3", requests: 1, cost: 0.02, allowance: 0.01 }),
          modelUsage({ model: "kimi-k3", requests: 1, cost: 0.1, allowance: 0 }),
        ],
      }),
      switches: [],
      threshold: 100,
    })
    const lines = formatStatusTable(status).split("\n")
    const todayIndex = lines.indexOf("Models today")
    const monthIndex = lines.indexOf("Models this month")
    expect(todayIndex).toBeGreaterThan(-1)
    expect(monthIndex).toBeGreaterThan(todayIndex)
    expect(lines.slice(todayIndex, monthIndex).join("\n")).toContain("glm-5.3")
    expect(lines.slice(todayIndex, monthIndex).join("\n")).not.toContain("deepseek-v4")
    expect(lines.slice(monthIndex).join("\n")).toContain("deepseek-v4")
    expect(lines.slice(monthIndex).join("\n")).toContain("glm-5.3")
    expect(lines.slice(monthIndex).find((line) => line.includes("kimi-k3"))?.trimEnd().endsWith("—")).toBe(true)
  })

  test("shows model display names instead of IDs", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas,
      cooldowns,
      today: empty,
      month: aggregate({
        entries: 1,
        models: [
          modelUsage({
            model: "deepseek-v4.1-flash",
            modelName: "DeepSeek V4.1 Flash 1017",
            requests: 1,
            cost: 0.5,
            allowance: 0.4,
          }),
        ],
      }),
      switches: [],
      threshold: 100,
    })
    const text = formatStatusTable(status)
    expect(text).toContain("DeepSeek V4.1 Flash 1017")
    expect(text).not.toContain("deepseek-v4.1-flash")
  })

  test("omits the model table when no usage is recorded", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas,
      cooldowns,
      today: empty,
      month: empty,
      switches: [],
      threshold: 100,
    })
    const text = formatStatusTable(status)
    expect(text).not.toContain("Models today")
    expect(text).not.toContain("Models this month")
  })

  test("does not repeat identical today and month totals", () => {
    const status = buildStatus({
      dataDir: "/data",
      owner: "alice",
      machineID: "mch_test",
      accounts,
      state,
      quotas,
      cooldowns,
      today: month,
      month,
      switches: [],
      threshold: 100,
    })
    const text = formatStatusTable(status)
    expect(text).toContain("This machine:")
    expect(text).not.toContain("This month:")
    expect(text).not.toContain("Today:")
    expect(text).toContain("Models this month")
    expect(text).not.toContain("Models today")
  })

  test("small formatting helpers", () => {
    expect(percent(12.34)).toBe("12.3%")
    expect(percent(undefined)).toBe("—")
    expect(money(0.1234)).toBe("$0.1234")
    expect(money(12.345)).toBe("$12.35")
    expect(money(0.000009)).toBe("$0.000009")
    expect(money(0.002599908)).toBe("$0.002600")
    expect(money(0.0000001)).toBe("$0.0000001")
    expect(money(0)).toBe("$0.00")
    expect(compact(999)).toBe("999")
    expect(compact(1000)).toBe("1.0k")
    expect(compact(1_000_000)).toBe("1.0M")
    expect(tokensText(tokens({ input: 1000, output: 200 }))).toContain("1.0k in")
  })
})
