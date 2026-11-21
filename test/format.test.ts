import { describe, expect, test } from "bun:test"
import { activeAccount, compact, modelLine, money, percent, planValue, quotaLine, quotaTone, usageLines } from "../src/format"
import { account, accountUsage, aggregate, modelUsage, tokens } from "./helpers"
import { buildStatus } from "../src/status"

const accounts = [account({ id: "a", label: "Account A" })]
const state = { version: 1 as const, order: ["a"], disabled: [], activeID: "a", updatedAt: 0 }
const quotas = {
  version: 1 as const,
  accounts: {
    a: {
      fetchedAt: Date.now(),
      rolling: { percent: 95, limited: false, status: "ok", resetsAt: null },
      weekly: { percent: 40, limited: false, status: "ok", resetsAt: null },
      monthly: { percent: 20, limited: false, status: "ok", resetsAt: null },
    },
  },
}

function status() {
  return buildStatus({
    dataDir: "/data",
    owner: "alice",
    machineID: "mch_test",
    accounts,
    state,
    quotas,
    cooldowns: { version: 1, accounts: {} },
    today: aggregate({
      entries: 2,
      cost: 0.75,
      allowance: 0.25,
      tokens: tokens({ input: 100, output: 20 }),
      models: [
        modelUsage({
          model: "deepseek-v4.1-flash",
          modelName: "DeepSeek V4.1 Flash 1017",
          requests: 2,
          cost: 0.75,
          allowance: 0.25,
          input: 100,
          output: 20,
        }),
      ],
      accounts: { a: accountUsage({ requests: 2, cost: 0.75, allowance: 0.25, tokens: tokens({ input: 100, output: 20 }) }) },
    }),
    month: aggregate({
      entries: 3,
      cost: 1.5,
      allowance: 0.5,
      tokens: tokens({ input: 200, output: 40 }),
      models: [
        modelUsage({
          model: "deepseek-v4.1-flash",
          modelName: "DeepSeek V4.1 Flash 1017",
          requests: 3,
          cost: 1.5,
          allowance: 0.5,
          input: 200,
          output: 40,
        }),
      ],
      accounts: { a: accountUsage({ requests: 3, cost: 1.5, allowance: 0.5, tokens: tokens({ input: 200, output: 40 }) }) },
    }),
    switches: [],
    threshold: 100,
  })
}

describe("format", () => {
  test("formats compact values and money", () => {
    expect(compact(0)).toBe("0")
    expect(compact(999)).toBe("999")
    expect(compact(1_500)).toBe("1.5k")
    expect(compact(2_400_000)).toBe("2.4M")
    expect(money(0)).toBe("$0.00")
    expect(money(0.004)).toBe("$0.0040")
    expect(money(1.234)).toBe("$1.23")
    expect(planValue(0)).toBe("plan n/a")
  })

  test("formats quota and chooses the active account", () => {
    const value = status()
    expect(activeAccount(value)?.id).toBe("a")
    expect(percent({ percent: 36, limited: false, status: "ok", resetsAt: null })).toBe("36%")
    expect(percent(undefined)).toBe("—")
    expect(quotaLine(activeAccount(value))).toBe("5h 95% · week 40% · month 20%")
    expect(quotaTone(value)).toBe("warning")
  })

  test("builds model and usage lines", () => {
    const value = status()
    const line = modelLine(value.today.models[0]!)
    expect(line).toContain("DeepSeek V4.1 Flash 1017")
    expect(line).toContain("2")
    const lines = usageLines(value)
    expect(lines[0]).toContain("OpenCode Go Pool — 1 account(s)")
    expect(lines).toContain("Models today")
    expect(lines.join("\n")).toContain("$0.75 list")
    expect(usageLines(undefined)).toEqual(["Loading OpenCode Go usage…"])
  })
})
