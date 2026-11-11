import { describe, expect, test } from "bun:test"
import { win32 } from "node:path"
import { configDirectory, defaultDataDirectory, paths, settings } from "../src/config"

describe("portable paths", () => {
  test("Linux follows XDG", () => {
    expect(defaultDataDirectory({}, "linux", "/home/alice")).toBe("/home/alice/.local/share/opencode-go-pool")
    expect(defaultDataDirectory({ XDG_DATA_HOME: "/data" }, "linux", "/home/alice")).toBe(
      "/data/opencode-go-pool",
    )
  })

  test("macOS uses Application Support", () => {
    expect(defaultDataDirectory({}, "darwin", "/Users/alice")).toBe(
      "/Users/alice/Library/Application Support/opencode-go-pool",
    )
  })

  test("Windows uses APPDATA", () => {
    expect(defaultDataDirectory({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32", "C:\\Users\\alice")).toBe(
      win32.join("C:\\Users\\alice\\AppData\\Roaming", "opencode-go-pool"),
    )
    expect(defaultDataDirectory({}, "win32", "C:\\Users\\alice")).toBe(
      win32.join("C:\\Users\\alice\\AppData\\Roaming", "opencode-go-pool"),
    )
  })

  test("environment override wins and expands home", () => {
    expect(defaultDataDirectory({ OPENCODE_GO_POOL_DIR: "/custom/pool" }, "linux", "/home/alice")).toBe("/custom/pool")
    expect(defaultDataDirectory({ OPENCODE_GO_POOL_DIR: "~/pool" }, "linux", "/home/alice")).toBe("/home/alice/pool")
    expect(defaultDataDirectory({ OPENCODE_GO_POOL_DIR: "~" }, "linux", "/home/alice")).toBe("/home/alice")
  })

  test("OpenCode config follows its own XDG convention", () => {
    expect(configDirectory({}, "linux", "/home/alice")).toBe("/home/alice/.config/opencode")
    expect(configDirectory({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/alice")).toBe("/cfg/opencode")
    expect(configDirectory({}, "win32", "C:\\Users\\alice")).toBe(win32.join("C:\\Users\\alice", ".config", "opencode"))
  })

  test("paths are rooted at the data directory", () => {
    const result = paths("/data")
    expect(result.status).toBe("/data/status.json")
    expect(result.events).toBe("/data/events")
  })

  test("the dashboard is opt-in", () => {
    expect(settings().dashboard).toBe(false)
    expect(settings({ dashboard: true }).dashboard).toBe(true)
  })
})
