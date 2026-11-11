import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { readJson, writeJsonAtomic } from "./fs-utils"

export interface MachineRecord {
  version: 1
  id: string
  createdAt: number
}

export async function resolveMachine(directory: string): Promise<string> {
  const file = join(directory, "machine.json")
  const record = await readJson<MachineRecord>(file)
  if (record?.version === 1 && typeof record.id === "string" && record.id.length > 0) return record.id
  const id = `mch_${randomUUID().slice(0, 8)}`
  await writeJsonAtomic(file, { version: 1, id, createdAt: Date.now() } satisfies MachineRecord)
  return id
}
