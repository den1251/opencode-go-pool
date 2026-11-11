import { userInfo } from "node:os"
import { join } from "node:path"
import { readJson, writeJsonAtomic } from "./fs-utils"

export interface OwnerRecord {
  version: 1
  name: string
  updatedAt: number
}

export function ownerFile(directory: string) {
  return join(directory, "owner.json")
}

export function cleanOwner(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const cleaned = value.trim().replaceAll(/\s+/g, " ").slice(0, 64)
  return cleaned.length > 0 ? cleaned : undefined
}

export async function resolveOwner(directory: string, configured?: string): Promise<string> {
  const record = await readJson<OwnerRecord>(ownerFile(directory))
  if (record?.version === 1 && cleanOwner(record.name)) return cleanOwner(record.name)!
  return cleanOwner(configured) ?? cleanOwner(process.env.OPENCODE_GO_POOL_OWNER) ?? defaultOwner()
}

export async function setOwner(directory: string, value: string): Promise<string> {
  const name = cleanOwner(value)
  if (!name) throw new Error("Owner name must not be empty")
  await writeJsonAtomic(ownerFile(directory), { version: 1, name, updatedAt: Date.now() } satisfies OwnerRecord)
  return name
}

function defaultOwner() {
  try {
    return userInfo().username || "unknown"
  } catch {
    return "unknown"
  }
}
