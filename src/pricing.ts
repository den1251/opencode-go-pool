import type { Tokens } from "./types"

export interface PricingTier {
  tier?: { type?: string; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export function estimateCost(tiers: PricingTier[] | undefined, tokens: Tokens): number {
  if (!tiers || tiers.length === 0) return 0
  const context = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const tier =
    tiers
      .filter((item) => item.tier?.type === "context" && context > item.tier.size)
      .sort((left, right) => (right.tier?.size ?? 0) - (left.tier?.size ?? 0))[0] ??
    tiers.find((item) => item.tier === undefined)
  if (!tier) return 0
  return (
    (tokens.input * tier.input +
      (tokens.output + tokens.reasoning) * tier.output +
      tokens.cacheRead * tier.cache.read +
      tokens.cacheWrite * tier.cache.write) /
    1_000_000
  )
}
