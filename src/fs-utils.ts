import { randomUUID } from "node:crypto"
import { open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export async function ensureDir(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600) {
  await ensureDir(dirname(file))
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode })
  await rename(temporary, file)
}

export async function writeTextAtomic(file: string, text: string, mode = 0o600) {
  await ensureDir(dirname(file))
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

export async function withLock<T>(directory: string, name: string, run: () => Promise<T>, timeoutMs = 4000): Promise<T> {
  await ensureDir(directory)
  const file = join(directory, `.${name}.lock`)
  const started = Date.now()
  while (true) {
    try {
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const age = await stat(file).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      )
      if (age > 15_000) await unlink(file).catch(() => {})
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${file}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    return await run()
  } finally {
    await unlink(file).catch(() => {})
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
