import { afterEach, describe, expect, test } from "bun:test"
import { resolveMachine } from "../src/machine"
import { cleanup, tempDir } from "./helpers"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe("machine identity", () => {
  test("creates once and persists", async () => {
    const dir = await tempDir("machine")
    dirs.push(dir)
    const first = await resolveMachine(dir)
    const second = await resolveMachine(dir)
    expect(first).toStartWith("mch_")
    expect(second).toBe(first)
  })
})
