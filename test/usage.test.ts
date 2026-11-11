import { describe, expect, test } from "bun:test"
import { normalizeRawUsage, readResponseUsage } from "../src/usage"

describe("raw usage extraction", () => {
  test("reads the exact OpenCode Go fields", () => {
    const usage = normalizeRawUsage({
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        cost: 0.00412,
        opencode: {
          billing_source: "go",
          list_cost: 0.0085,
          allowance: 0.006,
          tokens: {
            input: 1200,
            output: 300,
            reasoning: 120,
            cache_read: 8000,
            cache_write_5m: 10,
            cache_write_1h: 5,
          },
        },
      },
    })
    expect(usage?.tokens).toEqual({ input: 1200, output: 180, reasoning: 120, cacheRead: 8000, cacheWrite: 15 })
    expect(usage?.charged).toBe(0.00412)
    expect(usage?.listCost).toBe(0.0085)
    expect(usage?.allowance).toBe(0.006)
    expect(usage?.billingSource).toBe("go")
  })

  test("separates cached and reasoning tokens from standard OpenAI usage", () => {
    const usage = normalizeRawUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 200 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    })
    expect(usage?.tokens).toEqual({ input: 800, output: 90, reasoning: 10, cacheRead: 200 })
  })

  test("reads Anthropic and Gemini style usage", () => {
    expect(
      normalizeRawUsage({
        usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
      })?.tokens,
    ).toEqual({ input: 50, output: 7, cacheRead: 20, cacheWrite: 3 })
    expect(
      normalizeRawUsage({
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, cachedContentTokenCount: 40, thoughtsTokenCount: 5 },
      })?.tokens,
    ).toEqual({ input: 60, output: 25, reasoning: 5, cacheRead: 40 })
  })

  test("returns undefined when a body has no usage", () => {
    expect(normalizeRawUsage({ choices: [] })).toBeUndefined()
    expect(normalizeRawUsage(null)).toBeUndefined()
  })

  test("reads a JSON response body", async () => {
    const response = Response.json({
      usage: { cost: 0, opencode: { list_cost: 0.01, allowance: 0.01, tokens: { input: 5, output: 2 } } },
    })
    const usage = await readResponseUsage(response)
    expect(usage?.listCost).toBe(0.01)
    expect(usage?.allowance).toBe(0.01)
    expect(usage?.tokens).toEqual({ input: 5, output: 2 })
  })

  test("reads the final usage chunk of an SSE stream", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0,"opencode":{"list_cost":0.02,"allowance":0.015,"tokens":{"input":100,"output":20,"reasoning":0}}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } })
    const usage = await readResponseUsage(response)
    expect(usage?.listCost).toBe(0.02)
    expect(usage?.allowance).toBe(0.015)
    expect(usage?.tokens).toEqual({ input: 100, output: 20, reasoning: 0 })
  })

  test("merges split SSE chunks", async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"usage":{"cost":0,"opencode":{"list_cost":0.03,'))
        controller.enqueue(encoder.encode('"allowance":0.02,"tokens":{"input":7,"output":3}}}}\n\n'))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const usage = await readResponseUsage(response)
    expect(usage?.listCost).toBe(0.03)
    expect(usage?.tokens).toEqual({ input: 7, output: 3 })
  })
})
