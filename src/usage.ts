import type { Tokens } from "./types"

export interface RawUsage {
  tokens?: Partial<Tokens>
  charged?: number
  listCost?: number
  allowance?: number
  billingSource?: string
}

export function normalizeRawUsage(value: unknown): RawUsage | undefined {
  const root = record(value)
  if (!root) return undefined
  const response = record(root.response)
  const candidates = [
    record(root.usage),
    record(response?.usage),
    record(root.usageMetadata),
    record(response?.usageMetadata),
  ]
  for (const usage of candidates) {
    if (!usage) continue
    const parsed = readUsage(usage)
    if (parsed) return parsed
  }
  return undefined
}

function readUsage(usage: Record<string, unknown>): RawUsage | undefined {
  const opencode = record(usage.opencode)
  const opencodeTokens = record(opencode?.tokens)
  const tokens = opencodeTokens ? readTokenFields(opencodeTokens) : readStandardTokens(usage)
  const charged = numberValue(usage.cost)
  const listCost = numberValue(opencode?.list_cost) ?? numberValue(opencode?.listCost)
  const allowance = numberValue(opencode?.allowance)
  const billingSource = stringValue(opencode?.billing_source) ?? stringValue(opencode?.billingSource)
  if (!tokens && charged === undefined && listCost === undefined && allowance === undefined && billingSource === undefined) {
    return undefined
  }
  return {
    ...(tokens ? { tokens } : {}),
    ...(charged !== undefined ? { charged } : {}),
    ...(listCost !== undefined ? { listCost } : {}),
    ...(allowance !== undefined ? { allowance } : {}),
    ...(billingSource ? { billingSource } : {}),
  }
}

function readTokenFields(raw: Record<string, unknown>): Partial<Tokens> | undefined {
  const input = numberValue(raw.input)
  const billedOutput = numberValue(raw.output)
  const reasoning = numberValue(raw.reasoning)
  const cacheRead = numberValue(raw.cache_read) ?? numberValue(raw.cacheRead)
  const cacheWrite =
    (numberValue(raw.cache_write_5m) ?? 0) +
    (numberValue(raw.cache_write_1h) ?? 0) +
    (numberValue(raw.cache_write) ?? numberValue(raw.cacheWrite) ?? 0)
  const hasWrite =
    numberValue(raw.cache_write_5m) !== undefined ||
    numberValue(raw.cache_write_1h) !== undefined ||
    numberValue(raw.cache_write) !== undefined ||
    numberValue(raw.cacheWrite) !== undefined
  if (input === undefined && billedOutput === undefined && reasoning === undefined && cacheRead === undefined && !hasWrite) {
    return undefined
  }
  return {
    ...(input !== undefined ? { input } : {}),
    // `opencode.tokens.output` includes reasoning; OpenCode's normalized `output` is visible output only.
    ...(billedOutput !== undefined
      ? { output: Math.max(0, billedOutput - (reasoning ?? 0)) }
      : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(hasWrite ? { cacheWrite } : {}),
  }
}

function readStandardTokens(usage: Record<string, unknown>): Partial<Tokens> | undefined {
  const prompt = numberValue(usage.prompt_tokens)
  const completion = numberValue(usage.completion_tokens)
  const anthropicInput = numberValue(usage.input_tokens)
  const anthropicOutput = numberValue(usage.output_tokens)
  const geminiPrompt = numberValue(usage.promptTokenCount)
  const geminiOutput = numberValue(usage.candidatesTokenCount)
  const cached =
    numberValue(record(usage.prompt_tokens_details)?.cached_tokens) ??
    numberValue(usage.cache_read_input_tokens) ??
    numberValue(usage.prompt_cache_hit_tokens) ??
    numberValue(usage.cachedContentTokenCount)
  const cacheWrite =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.prompt_cache_miss_tokens)
  const reasoning =
    numberValue(record(usage.completion_tokens_details)?.reasoning_tokens) ??
    numberValue(usage.reasoning_tokens) ??
    numberValue(record(usage.output_tokens_details)?.reasoning_tokens) ??
    numberValue(usage.thoughtsTokenCount)
  const input =
    prompt !== undefined
      ? Math.max(0, prompt - (cached ?? 0))
      : anthropicInput !== undefined
        ? anthropicInput
        : geminiPrompt !== undefined
          ? Math.max(0, geminiPrompt - (cached ?? 0))
          : undefined
  const output =
    completion !== undefined
      ? Math.max(0, completion - (reasoning ?? 0))
      : anthropicOutput !== undefined
        ? Math.max(0, anthropicOutput - (reasoning ?? 0))
        : geminiOutput !== undefined
          ? Math.max(0, geminiOutput - (reasoning ?? 0))
          : undefined
  if (input === undefined && output === undefined && cached === undefined && cacheWrite === undefined && reasoning === undefined) {
    return undefined
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cached !== undefined ? { cacheRead: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
}

export async function readResponseUsage(response: Response): Promise<RawUsage | undefined> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  if (contentType.includes("text/event-stream")) return readStreamUsage(response)

  let text: string
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("data:") || contentType.includes("ndjson")) return readLines(trimmed)
  try {
    return normalizeRawUsage(JSON.parse(trimmed))
  } catch {
    return readLines(trimmed)
  }
}

async function readStreamUsage(response: Response): Promise<RawUsage | undefined> {
  const body = response.body
  if (!body) return readLines(await response.text().catch(() => ""))
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: RawUsage | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        usage = readLine(buffer.slice(0, index), usage)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
      }
    }
    buffer += decoder.decode()
    if (buffer) usage = readLine(buffer, usage)
  } catch {
    return usage
  } finally {
    reader.releaseLock()
  }
  return usage
}

function readLines(text: string) {
  let usage: RawUsage | undefined
  for (const line of text.split(/\r?\n/)) usage = readLine(line, usage)
  return usage
}

function readLine(line: string, current: RawUsage | undefined) {
  const trimmed = line.trim()
  if (!trimmed) return current
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed
  if (!data || data === "[DONE]" || data.startsWith("event:")) return current
  try {
    return mergeUsage(current, normalizeRawUsage(JSON.parse(data)))
  } catch {
    return current
  }
}

function mergeUsage(current: RawUsage | undefined, next: RawUsage | undefined) {
  if (!next) return current
  if (!current) return next
  return {
    ...current,
    ...next,
    ...(next.tokens ? { tokens: { ...current.tokens, ...next.tokens } } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
