import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import type { UsageEntry } from "../src/types"
import { buildStatus } from "../src/status"
import { recordUsage, dayKey } from "../src/ledger"
import { ensureDir, writeJsonAtomic } from "../src/fs-utils"
import { cleanup, tempDir, account, accountUsage, aggregate, modelUsage, tokens } from "./helpers"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

async function run(dir: string, args: string[]) {
  const child = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, OPENCODE_GO_POOL_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await child.exited
  return {
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }
}

async function fixture() {
  const dir = await tempDir("cli")
  dirs.push(dir)
  await ensureDir(dir)
  const yesterday = Date.now() - 86_400_000
  await recordUsage(
    join(dir, "events"),
    entry({
      ts: yesterday,
      day: dayKey(yesterday),
      model: "deepseek-v4.1-flash",
      modelName: "DeepSeek V4.1 Flash 1017",
      cost: 0.5,
      listCost: 0.5,
      allowance: 0.1,
    }),
  )
  const accounts = [account({ id: "a", label: "Account A" }), account({ id: "b", label: "Account B" })]
  const status = buildStatus({
    dataDir: dir,
    owner: "alice",
    machineID: "mch_test",
    accounts,
    state: { version: 1, order: ["a", "b"], disabled: [], activeID: "a", updatedAt: 0 },
    quotas: { version: 1, accounts: {} },
    cooldowns: { version: 1, accounts: {} },
    today: aggregate(),
    month: aggregate({
      entries: 1,
      cost: 0.5,
      listCost: 0.5,
      allowance: 0.1,
      tokens: tokens({ input: 100, output: 20 }),
      models: [modelUsage({ model: "deepseek-v4.1-flash", modelName: "DeepSeek V4.1 Flash 1017", requests: 1, cost: 0.5, listCost: 0.5, allowance: 0.1, ...tokens({ input: 100, output: 20 }) })],
      owners: { alice: accountUsage({ requests: 1, cost: 0.5, listCost: 0.5, allowance: 0.1, tokens: tokens({ input: 100, output: 20 }) }) },
    }),
    switches: [],
    threshold: 100,
  })
  await writeJsonAtomic(join(dir, "status.json"), status)
  await writeJsonAtomic(join(dir, "accounts.json"), {
    version: 1,
    order: ["a", "b"],
    disabled: [],
    activeID: "a",
    updatedAt: 0,
  })
  await writeJsonAtomic(join(dir, "owner.json"), { version: 1, name: "alice", updatedAt: Date.now() })
  return dir
}

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    day: new Date().toISOString().slice(0, 10),
    owner: "alice",
    machineID: "mch_test",
    accountID: "a",
    accountLabel: "Account A",
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

describe("cli", () => {
  test("prints status in table and JSON forms", async () => {
    const dir = await fixture()
    const table = await run(dir, ["status"])
    expect(table.code).toBe(0)
    expect(table.stdout).toContain("Account A")
    expect(table.stdout).toContain("OpenCode Go Pool")
    expect(table.stdout).toContain("Models this month")
    expect(table.stdout).toContain("DeepSeek V4.1 Flash 1017")
    const json = await run(dir, ["status", "--json"])
    expect(JSON.parse(json.stdout).owner).toBe("alice")
  })

  test("recomputes usage from events instead of trusting a stale status file", async () => {
    const dir = await fixture()
    await recordUsage(
      join(dir, "events"),
      entry({ cost: 0.75, listCost: 0.75, allowance: 0.05 }),
    )
    const result = await run(dir, ["status", "--json"])
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.month.entries).toBe(2)
    expect(parsed.month.cost).toBeCloseTo(1.25, 10)
    expect(parsed.today.entries).toBe(1)
    const accountA = parsed.accounts.find((item: { id: string }) => item.id === "a")
    expect(accountA.month.cost).toBeCloseTo(1.25, 10)
    expect(accountA.today.cost).toBeCloseTo(0.75, 10)
  })

  test("prints the package version", async () => {
    const dir = await fixture()
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"))
    const result = await run(dir, ["--version"])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`opencode-go-pool ${pkg.version}`)
  })

  test("uses accounts", async () => {
    const dir = await fixture()
    const use = await run(dir, ["use", "Account B"])
    expect(use.code).toBe(0)
    const state = JSON.parse(await readFile(join(dir, "accounts.json"), "utf8"))
    expect(state.activeID).toBe("b")
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"))
    expect(status.activeID).toBe("b")
    expect(status.accounts.find((item: { id: string }) => item.id === "b").active).toBe(true)
    expect((await run(dir, ["use", "nope"])).code).toBe(1)
  })

  test("clears scoped usage and exports CSV", async () => {
    const dir = await fixture()
    await ensureDir(join(dir, "events"))
    await recordUsage(join(dir, "events"), entry({ owner: "alice" }))
    await recordUsage(join(dir, "events"), entry({ owner: "bob", accountID: "b" }))
    const csv = await run(dir, ["export", "--csv"])
    expect(csv.stdout).toContain("timestamp,day,owner")
    expect(csv.stdout).toContain("alice")
    expect(csv.stdout).toContain("bob")

    const cleared = await run(dir, ["clear", "--owner", "alice", "--yes"])
    expect(cleared.code).toBe(0)
    expect(cleared.stdout).toContain("Cleared 2")
    const remaining = await run(dir, ["export", "--json"])
    const parsed = JSON.parse(remaining.stdout)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].owner).toBe("bob")

    const all = await run(dir, ["clear", "--all", "--yes"])
    expect(all.stdout).toContain("Cleared 1")
    expect(JSON.parse((await run(dir, ["export"])).stdout)).toEqual([])
    const after = await run(dir, ["status"])
    expect(after.stdout).toContain("0 request(s)")
  })

  test("requires confirmation without a TTY", async () => {
    const dir = await fixture()
    await ensureDir(join(dir, "events"))
    await recordUsage(join(dir, "events"), entry())
    const result = await run(dir, ["clear", "--all"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--yes")
  })

  test("handles unknown commands", async () => {
    const result = await run(await fixture(), ["nope"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Unknown command")
  })
})
