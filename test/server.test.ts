import { afterEach, describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import plugin from "../src/server"
import type { Status } from "../src/types"
import { cleanup, tempDir } from "./helpers"

class Queue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private values: T[] = []
  private waiters: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return { value: this.values.shift()!, done: false }
    if (this.closed) return { value: undefined as never, done: true }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async return(): Promise<IteratorResult<T>> {
    this.close()
    return { value: undefined as never, done: true }
  }
}

function mockContext(connections: Array<{ id: string; label: string; key: string }>) {
  const hooks: Record<string, (input: any) => Promise<void> | void> = {}
  const queue = new Queue<any>()
  const context = {
    options: {},
    integration: {
      async list() {
        return {
          data: [
            {
              id: "opencode-go",
              name: "OpenCode Go",
              connections: connections.map((item) => ({
                type: "credential",
                id: item.id,
                label: item.label,
                method: "key",
              })),
            },
          ],
        }
      },
      connection: {
        async resolve(connection: { id: string }) {
          const found = connections.find((item) => item.id === connection.id)
          return found ? { type: "key", key: found.key } : undefined
        },
      },
    },
    event: {
      subscribe() {
        return queue
      },
    },
    model: {
      async list() {
        return {
          data: [
            {
              id: "deepseek-v4",
              providerID: "opencode-go",
              cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
            },
          ],
        }
      },
    },
    session: {
      async hook(name: string, callback: (input: any) => Promise<void> | void) {
        hooks[name] = callback
        return { async dispose() {} }
      },
    },
  }
  return { context, hooks, queue }
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe("plugin integration", () => {
  test("rotates accounts, retries a 429, records owner usage and shows status", async () => {
    const dir = await tempDir("server")
    dirs.push(dir)
    let failFirst = false
    let quotaFirst = 0
    let quotaSecond = 0
    const seenAuth: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/usage") {
          const authorization = request.headers.get("authorization") ?? ""
          const percent = authorization.includes("key_one") ? quotaFirst : quotaSecond
          return Response.json({
            usage: {
              rolling: { status: "ok", percent, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
              weekly: { status: "ok", percent, resetsAt: new Date(Date.now() + 172_800_000).toISOString() },
              monthly: { status: "ok", percent, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
            },
          })
        }
        const authorization = request.headers.get("authorization") ?? ""
        seenAuth.push(authorization)
        if (failFirst && authorization.includes("key_one")) {
          return Response.json({ error: { message: "quota" } }, { status: 429 })
        }
        return Response.json({ id: "chatcmpl", choices: [{ message: { role: "assistant", content: "hi" } }] })
      },
    })
    const mock = mockContext([
      { id: "cred_1", label: "Account 1", key: "key_one_1111" },
      { id: "cred_2", label: "Account 2", key: "key_two_2222" },
    ])
    mock.context.options = {
      dataDir: dir,
      owner: "alice",
      dashboard: false,
      refreshSeconds: 1,
      usageURL: `http://127.0.0.1:${server.port}/usage`,
      upstream: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 2000,
    }

    const cleanupPlugin = await (plugin as any).setup(mock.context)
    await Bun.sleep(100)
    expect(mock.hooks["http.request"]).toBeDefined()
    expect(mock.hooks["http.response"]).toBeDefined()

    const request = () =>
      new Request("https://opencode.ai/inference/go/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer old", "content-type": "application/json" },
        body: JSON.stringify({ stream: false, messages: [] }),
      })

    const firstInput: any = {
      sessionID: "ses_1",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: request(),
    }
    await mock.hooks["http.request"]!(firstInput)
    expect(firstInput.request.headers.get("authorization")).toBe("Bearer key_one_1111")
    expect(firstInput.request.url).toStartWith(`http://127.0.0.1:${server.port}/inference/`)

    const firstResponse: any = {
      ...firstInput,
      response: Response.json({ ok: true }),
    }
    await mock.hooks["http.response"]!(firstResponse)
    expect(firstResponse.response.status).toBe(200)

    mock.queue.push({
      id: "evt_step_1",
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        model: { id: "deepseek-v4", providerID: "opencode-go" },
        cost: 0.25,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 0 } },
      },
    })
    await Bun.sleep(500)

    let status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Status
    expect(status.owner).toBe("alice")
    expect(status.month.cost).toBe(0.25)
    expect(status.month.owners.alice?.cost).toBe(0.25)
    expect(status.month.models[0]?.model).toBe("deepseek-v4")
    expect(status.accounts[0]?.active).toBe(true)

    mock.queue.push({
      id: "evt_step_2",
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        model: { id: "deepseek-v4", providerID: "opencode-go" },
        cost: 0,
        tokens: { input: 1_000_000, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    await Bun.sleep(500)
    status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Status
    expect(status.month.estimated).toBe(1)
    expect(status.month.cost).toBeCloseTo(1, 5)

    quotaFirst = 100
    await Bun.sleep(1100)
    const switchInput: any = {
      sessionID: "ses_2",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: request(),
    }
    await mock.hooks["http.request"]!(switchInput)
    expect(switchInput.request.headers.get("authorization")).toBe("Bearer key_two_2222")

    failFirst = true
    quotaFirst = 50
    quotaSecond = 50
    await Bun.sleep(1100)
    const failInput: any = {
      sessionID: "ses_3",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: request(),
    }
    await mock.hooks["http.request"]!(failInput)
    failFirst = false
    const failResponse: any = { ...failInput, response: Response.json({ error: "quota" }, { status: 429 }) }
    await mock.hooks["http.response"]!(failResponse)
    expect(failResponse.response.status).toBe(200)
    expect(seenAuth.some((value) => value.includes("key_one"))).toBe(true)

    await Bun.sleep(150)
    const accountState = JSON.parse(await readFile(join(dir, "accounts.json"), "utf8"))
    expect(accountState.activeID).toBe("cred_1")
    status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Status
    expect(status.switches.length).toBeGreaterThan(0)
    expect(status.activeID).toBe("cred_1")

    quotaFirst = 100
    quotaSecond = 100
    await Bun.sleep(1100)
    const exhaustedInput: any = {
      sessionID: "ses_4",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: request(),
    }
    await mock.hooks["http.request"]!(exhaustedInput)
    const exhaustedResponse: any = {
      ...exhaustedInput,
      response: Response.json({ error: "quota" }, { status: 429 }),
    }
    await mock.hooks["http.response"]!(exhaustedResponse)
    expect(exhaustedResponse.response.status).toBe(429)
    const body = await exhaustedResponse.response.json()
    expect(body.error.type).toBe("go_pool_exhausted")

    mock.queue.close()
    await cleanupPlugin()
    server.stop(true)
  })

  test("records exact usage from the response body", async () => {
    const dir = await tempDir("server-raw")
    dirs.push(dir)
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/usage") {
          return Response.json({
            usage: {
              rolling: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
              weekly: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 172_800_000).toISOString() },
              monthly: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
            },
          })
        }
        return Response.json({ id: "chatcmpl", choices: [] })
      },
    })
    const mock = mockContext([{ id: "cred_1", label: "Account 1", key: "key_one_1111" }])
    mock.context.options = {
      dataDir: dir,
      owner: "alice",
      dashboard: false,
      refreshSeconds: 60,
      usageURL: `http://127.0.0.1:${server.port}/usage`,
      upstream: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 2000,
    }

    const cleanupPlugin = await (plugin as any).setup(mock.context)
    await Bun.sleep(100)

    const input: any = {
      sessionID: "ses_raw",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: new Request("https://opencode.ai/inference/go/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer old", "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [] }),
      }),
    }
    await mock.hooks["http.request"]!(input)
    await mock.hooks["http.response"]!({
      ...input,
      response: Response.json({
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 300,
          cost: 0,
          opencode: {
            billing_source: "go",
            list_cost: 0.00412,
            allowance: 0.003,
            tokens: { input: 1200, output: 300, reasoning: 120, cache_read: 8000, cache_write_5m: 0 },
          },
        },
      }),
    })

    mock.queue.push({
      id: "evt_raw_1",
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_raw",
        model: { id: "deepseek-v4", providerID: "opencode-go" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    await Bun.sleep(500)

    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Status
    expect(status.month.cost).toBe(0.00412)
    expect(status.month.listCost).toBe(0.00412)
    expect(status.month.allowance).toBe(0.003)
    expect(status.month.charged).toBe(0)
    expect(status.month.billing.go).toBe(1)
    expect(status.month.tokens).toEqual({ input: 1200, output: 180, reasoning: 120, cacheRead: 8000, cacheWrite: 0 })
    expect(status.month.estimated).toBe(0)

    const files = await readdir(join(dir, "events"))
    const stored = JSON.parse(await readFile(join(dir, "events", files[0]!), "utf8"))
    expect(stored.listCost).toBe(0.00412)
    expect(stored.allowance).toBe(0.003)
    expect(stored.charged).toBe(0)
    expect(stored.billingSource).toBe("go")
    expect(stored.metering).toBe("response")

    mock.queue.close()
    await cleanupPlugin()
    server.stop(true)
  })

  test("captures usage from the account that served a retry", async () => {
    const dir = await tempDir("server-retry-raw")
    dirs.push(dir)
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/usage") {
          return Response.json({
            usage: {
              rolling: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
              weekly: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 172_800_000).toISOString() },
              monthly: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
            },
          })
        }
        const authorization = request.headers.get("authorization") ?? ""
        if (authorization.includes("key_one")) {
          return Response.json({ error: { message: "quota" } }, { status: 429 })
        }
        return Response.json({
          choices: [],
          usage: { cost: 0, opencode: { billing_source: "go", list_cost: 0.02, allowance: 0.015, tokens: { input: 5, output: 1 } } },
        })
      },
    })
    const mock = mockContext([
      { id: "cred_1", label: "Account 1", key: "key_one_1111" },
      { id: "cred_2", label: "Account 2", key: "key_two_2222" },
    ])
    mock.context.options = {
      dataDir: dir,
      owner: "alice",
      dashboard: false,
      refreshSeconds: 60,
      usageURL: `http://127.0.0.1:${server.port}/usage`,
      upstream: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 2000,
    }

    const cleanupPlugin = await (plugin as any).setup(mock.context)
    await Bun.sleep(100)
    const input: any = {
      sessionID: "ses_retry",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: new Request("https://opencode.ai/inference/go/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer old", "content-type": "application/json" },
        body: JSON.stringify({ stream: false, messages: [] }),
      }),
    }
    await mock.hooks["http.request"]!(input)
    const hit: any = { ...input, response: Response.json({ error: "quota" }, { status: 429 }) }
    await mock.hooks["http.response"]!(hit)
    expect(hit.response.status).toBe(200)

    mock.queue.push({
      id: "evt_retry_raw",
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_retry",
        model: { id: "deepseek-v4", providerID: "opencode-go" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    await Bun.sleep(500)

    const entries = await readdir(join(dir, "events"))
    const stored = JSON.parse(await readFile(join(dir, "events", entries[0]!), "utf8"))
    expect(stored.accountID).toBe("cred_2")
    expect(stored.accountLabel).toBe("Account 2")
    expect(stored.listCost).toBe(0.02)
    expect(stored.allowance).toBe(0.015)
    expect(stored.metering).toBe("response")

    mock.queue.close()
    await cleanupPlugin()
    server.stop(true)
  })

  test("attributes a step when hooks and events run in different plugin instances", async () => {
    const dir = await tempDir("server-shared")
    dirs.push(dir)
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/usage") {
          return Response.json({
            usage: {
              rolling: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
              weekly: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 172_800_000).toISOString() },
              monthly: { status: "ok", percent: 0, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
            },
          })
        }
        return Response.json({
          choices: [],
          usage: { cost: 0, opencode: { billing_source: "go", list_cost: 0.01, allowance: 0.007, tokens: { input: 4, output: 2 } } },
        })
      },
    })
    const options = {
      dataDir: dir,
      owner: "alice",
      dashboard: false,
      refreshSeconds: 60,
      usageURL: `http://127.0.0.1:${server.port}/usage`,
      upstream: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: 2000,
    }
    const mockA = mockContext([{ id: "cred_1", label: "Account 1", key: "key_one_1111" }])
    const mockB = mockContext([{ id: "cred_1", label: "Account 1", key: "key_one_1111" }])
    mockA.context.options = options
    mockB.context.options = options

    const cleanupA = await (plugin as any).setup(mockA.context)
    const cleanupB = await (plugin as any).setup(mockB.context)
    await Bun.sleep(100)

    const input: any = {
      sessionID: "ses_shared",
      agent: "build",
      model: { id: "deepseek-v4", providerID: "opencode-go" },
      kind: "primary",
      request: new Request("https://opencode.ai/inference/go/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer old", "content-type": "application/json" },
        body: JSON.stringify({ stream: false, messages: [] }),
      }),
    }
    await mockA.hooks["http.request"]!(input)
    await mockB.hooks["http.response"]!({
      ...input,
      response: Response.json({
        choices: [],
        usage: { cost: 0, opencode: { billing_source: "go", list_cost: 0.01, allowance: 0.007, tokens: { input: 4, output: 2 } } },
      }),
    })

    const stepEvent = {
      id: "evt_shared",
      created: Date.now(),
      type: "session.step.ended",
      data: {
        sessionID: "ses_shared",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }
    mockA.queue.push(stepEvent)
    mockB.queue.push(stepEvent)
    await Bun.sleep(1000)

    const entries = await readdir(join(dir, "events"))
    const stored = JSON.parse(await readFile(join(dir, "events", entries[0]!), "utf8"))
    expect(stored.accountID).toBe("cred_1")
    expect(stored.accountLabel).toBe("Account 1")
    expect(stored.model).toBe("deepseek-v4")
    expect(stored.listCost).toBe(0.01)

    mockA.queue.close()
    mockB.queue.close()
    await cleanupA()
    await cleanupB()
    server.stop(true)
  })
})
