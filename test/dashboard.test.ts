import { afterEach, describe, expect, test } from "bun:test"
import { startDashboard, type Dashboard } from "../src/dashboard"
import type { Status } from "../src/types"
import { cleanup, tempDir, aggregate } from "./helpers"

let dashboard: Dashboard | undefined
const dirs: string[] = []
afterEach(async () => {
  await dashboard?.close()
  dashboard = undefined
  await Promise.all(dirs.splice(0).map(cleanup))
})

function status(owner = "alice"): Status {
  return {
    version: 1,
    generatedAt: Date.now(),
    dataDir: "/data",
    owner,
    machineID: "mch_test",
    activeID: null,
    accounts: [],
    today: aggregate(),
    month: aggregate(),
    switches: [],
  }
}

function endpoint(path: string) {
  if (!dashboard) throw new Error("dashboard not started")
  const url = new URL(dashboard.url)
  url.pathname = path
  return url.toString()
}

describe("dashboard", () => {
  test("requires the token and serves status, html and refresh", async () => {
    let refreshed = 0
    dashboard = await startDashboard({
      port: 0,
      getStatus: async () => status(),
      refresh: async () => {
        refreshed += 1
      },
      clear: async () => ({ removed: 2 }),
    })
    expect(dashboard.url).toContain("token=")
    const forbidden = await fetch(`http://127.0.0.1:${dashboard.port}/api/status`)
    expect(forbidden.status).toBe(403)

    const api = await fetch(endpoint("/api/status"))
    expect(api.status).toBe(200)
    expect((await api.json()).owner).toBe("alice")

    const html = await fetch(dashboard.url)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain("OpenCode Go Pool")

    const refresh = await fetch(endpoint("/api/refresh"), { method: "POST" })
    expect(refresh.status).toBe(200)
    expect(refreshed).toBe(1)
  })

  test("guards all-clear and runs scoped clear", async () => {
    const filters: unknown[] = []
    dashboard = await startDashboard({
      port: 0,
      getStatus: async () => status(),
      refresh: async () => {},
      clear: async (filter) => {
        filters.push(filter)
        return { removed: 3 }
      },
    })
    const missingConfirm = await fetch(endpoint("/api/clear"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    })
    expect(missingConfirm.status).toBe(400)

    const body = await fetch(endpoint("/api/clear"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "alice", confirm: true }),
    })
    expect(body.status).toBe(200)
    const value = await body.json()
    expect(value.removed).toBe(3)
    expect(filters[0]).toEqual({ owner: "alice" })
  })

  test("returns 404 for unknown routes", async () => {
    dashboard = await startDashboard({
      port: 0,
      getStatus: async () => status(),
      refresh: async () => {},
      clear: async () => ({ removed: 0 }),
    })
    const response = await fetch(endpoint("/nope"))
    expect(response.status).toBe(404)
  })
})
