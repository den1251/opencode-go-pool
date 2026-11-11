import { afterEach, describe, expect, test } from "bun:test"
import { cleanOwner, ownerFile, resolveOwner, setOwner } from "../src/identity"
import { readJson } from "../src/fs-utils"
import type { OwnerRecord } from "../src/identity"
import { cleanup, tempDir } from "./helpers"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

async function directory() {
  const value = await tempDir("identity")
  dirs.push(value)
  return value
}

describe("identity", () => {
  test("cleans owner names", () => {
    expect(cleanOwner("  Alice   Smith  ")).toBe("Alice Smith")
    expect(cleanOwner("")).toBeUndefined()
    expect(cleanOwner(undefined)).toBeUndefined()
    expect(cleanOwner("x".repeat(100))?.length).toBe(64)
  })

  test("persists and resolves an owner", async () => {
    const dir = await directory()
    expect(await setOwner(dir, "  Bob  ")).toBe("Bob")
    expect((await readJson<OwnerRecord>(ownerFile(dir)))?.name).toBe("Bob")
    expect(await resolveOwner(dir)).toBe("Bob")
  })

  test("prefers the stored owner over configuration and env", async () => {
    const dir = await directory()
    process.env.OPENCODE_GO_POOL_OWNER = "env-owner"
    try {
      expect(await resolveOwner(dir, "option-owner")).toBe("option-owner")
      await setOwner(dir, "stored")
      expect(await resolveOwner(dir, "option-owner")).toBe("stored")
    } finally {
      delete process.env.OPENCODE_GO_POOL_OWNER
    }
  })

  test("rejects empty owner", async () => {
    const dir = await directory()
    expect(setOwner(dir, "   ")).rejects.toThrow("empty")
  })
})
