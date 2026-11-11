import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { AccountUsage, Aggregate, ModelUsage, Tokens } from "../src/types"

export async function tempDir(name: string) {
  await mkdir("/tmp/opencode", { recursive: true })
  return mkdtemp(join("/tmp/opencode", `${name}-`))
}

export async function cleanup(directory: string) {
  await rm(directory, { recursive: true, force: true })
}

export function account(overrides: Partial<import("../src/types").Account> = {}) {
  return {
    id: "cred_1",
    label: "Account 1",
    method: "key" as const,
    token: "oc_sk_one_1234",
    keyHint: "...1234",
    source: "credential" as const,
    ...overrides,
  }
}

export function tokens(overrides: Partial<Tokens> = {}): Tokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

export function aggregate(overrides: Partial<Aggregate> = {}): Aggregate {
  return {
    since: 0,
    entries: 0,
    estimated: 0,
    cost: 0,
    listCost: 0,
    allowance: 0,
    charged: 0,
    tokens: tokens(),
    models: [],
    accounts: {},
    owners: {},
    billing: {},
    ...overrides,
  }
}

export function accountUsage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return { requests: 0, cost: 0, listCost: 0, allowance: 0, charged: 0, tokens: tokens(), ...overrides }
}

export function modelUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    providerID: "opencode-go",
    model: "deepseek-v4",
    requests: 0,
    cost: 0,
    listCost: 0,
    allowance: 0,
    ...tokens(),
    ...overrides,
  }
}
