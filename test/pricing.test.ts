import { describe, expect, test } from "bun:test"
import { estimateCost } from "../src/pricing"
import { tokens } from "./helpers"

describe("pricing", () => {
  test("returns zero without tiers", () => {
    expect(estimateCost(undefined, tokens())).toBe(0)
    expect(estimateCost([], tokens())).toBe(0)
  })

  test("computes input, output and cache prices per million", () => {
    const cost = estimateCost([{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0.375 } }], {
      input: 1_000_000,
      output: 1_000_000,
      reasoning: 0,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    })
    expect(cost).toBeCloseTo(1.128, 6)
  })

  test("charges reasoning tokens at the output price", () => {
    const cost = estimateCost([{ input: 0.15, output: 0.6, cache: { read: 0, write: 0 } }], {
      input: 0,
      output: 1_000_000,
      reasoning: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(cost).toBeCloseTo(1.2, 6)
  })

  test("selects the highest context tier the request exceeds", () => {
    const tiers = [
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
      { tier: { type: "context" as const, size: 200_000 }, input: 2, output: 4, cache: { read: 0, write: 0 } },
      { tier: { type: "context" as const, size: 500_000 }, input: 3, output: 6, cache: { read: 0, write: 0 } },
    ]
    expect(estimateCost(tiers, tokens({ input: 100_000, output: 1_000_000 }))).toBeCloseTo(2.1, 6)
    expect(estimateCost(tiers, tokens({ input: 300_000, output: 1_000_000 }))).toBeCloseTo(4.6, 6)
  })

  test("uses the base price at or below the smallest tier", () => {
    const tiers = [{ tier: { type: "context" as const, size: 10_000 }, input: 5, output: 0, cache: { read: 0, write: 0 } }]
    expect(estimateCost(tiers, tokens({ input: 100 }))).toBe(0)
  })
})
