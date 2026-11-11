import { describe, expect, test } from "bun:test"
import { fetchQuota, isExhausted, limitingReset, nextReset, parseQuota, quotaFresh, windows } from "../src/quota"
import { account } from "./helpers"

const now = Date.now()

describe("quota parsing", () => {
  test("parses all three windows", () => {
    const snapshot = parseQuota({
      usage: {
        rolling: { status: "ok", percent: 12.5, resetsAt: new Date(now + 3600_000).toISOString() },
        weekly: { status: "ok", percent: 34, resetsAt: now + 7200_000 },
        monthly: { status: "rate-limited", percent: 100, resetsAt: now + 86_400_000 },
      },
    })
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.rolling?.percent).toBe(12.5)
    expect(snapshot.weekly?.percent).toBe(34)
    expect(snapshot.monthly?.limited).toBe(true)
    expect(snapshot.monthly?.resetsAt).toBeGreaterThan(now)
    expect(windows(snapshot)).toHaveLength(3)
  })

  test("treats percent 100 as limited", () => {
    const snapshot = parseQuota({ usage: { rolling: { status: "ok", percent: 100, resetsAt: null } } })
    expect(snapshot.rolling?.limited).toBe(true)
  })

  test("rejects a body without usage", () => {
    expect(parseQuota({}).error).toContain("no usage")
    expect(parseQuota(null).error).toContain("no usage")
  })

  test("rejects a body without windows", () => {
    expect(parseQuota({ usage: {} }).error).toContain("no windows")
  })

  test("ignores malformed windows", () => {
    const snapshot = parseQuota({
      usage: { rolling: { status: "ok", percent: 1 }, weekly: "bad", monthly: { percent: "bad" } },
    })
    expect(snapshot.rolling?.percent).toBe(1)
    expect(snapshot.weekly).toBeUndefined()
    expect(snapshot.monthly?.percent).toBe(0)
  })
})

describe("quota decisions", () => {
  const snapshot = parseQuota({
    usage: {
      rolling: { status: "ok", percent: 10, resetsAt: now - 1000 },
      weekly: { status: "ok", percent: 20, resetsAt: now + 1000_000 },
      monthly: { status: "ok", percent: 30, resetsAt: now + 2000_000 },
    },
  })

  test("freshness window", () => {
    expect(quotaFresh(snapshot, 60, now)).toBe(true)
    expect(quotaFresh(snapshot, 0.001, now + 10_000)).toBe(false)
    expect(quotaFresh(undefined, 60)).toBe(false)
  })

  test("ignores expired windows", () => {
    expect(isExhausted(parseQuota({ usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: now - 1 } } }), 100)).toBe(false)
  })

  test("detects exhaustion at a threshold", () => {
    const value = parseQuota({ usage: { rolling: { status: "ok", percent: 99, resetsAt: null } } })
    expect(isExhausted(value, 100)).toBe(false)
    expect(isExhausted(value, 99)).toBe(true)
    expect(isExhausted({ fetchedAt: now, error: "network" }, 100)).toBe(false)
  })

  test("returns reset times", () => {
    expect(nextReset(snapshot)).toBe(now + 1000_000)
    expect(limitingReset(parseQuota({ usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: now + 100 } } }))).toBe(now + 100)
    expect(nextReset(undefined)).toBeNull()
  })
})

describe("fetchQuota", () => {
  test("sends auth and org headers and parses the reply", async () => {
    let seen: Headers | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen = request.headers
        return Response.json({ usage: { rolling: { status: "ok", percent: 7, resetsAt: null } } })
      },
    })
    try {
      const snapshot = await fetchQuota(account({ orgID: "org_1" }), {
        usageURL: `http://127.0.0.1:${server.port}/usage`,
        timeoutMs: 1000,
      })
      expect(snapshot.rolling?.percent).toBe(7)
      expect(seen?.get("authorization")).toBe("Bearer oc_sk_one_1234")
      expect(seen?.get("x-opencode-org-id")).toBe("org_1")
    } finally {
      server.stop(true)
    }
  })

  test("reports auth and subscription failures as errors", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const status = new URL(request.url).searchParams.get("status")
        return new Response("no", { status: Number(status) })
      },
    })
    try {
      const url = (status: number) => `http://127.0.0.1:${server.port}/usage?status=${status}`
      expect((await fetchQuota(account(), { usageURL: url(401), timeoutMs: 1000 })).error).toContain("401")
      expect((await fetchQuota(account(), { usageURL: url(403), timeoutMs: 1000 })).error).toContain("403")
      expect((await fetchQuota(account(), { usageURL: url(500), timeoutMs: 1000 })).error).toContain("500")
    } finally {
      server.stop(true)
    }
  })

  test("reports network failures", async () => {
    const snapshot = await fetchQuota(account(), { usageURL: "http://127.0.0.1:1/usage", timeoutMs: 200 })
    expect(snapshot.error).toContain("usage request failed")
  })
})
