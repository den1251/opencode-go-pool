import { createHash } from "node:crypto"
import type { Account } from "./types"

interface Connection {
  type: "credential" | "env"
  id?: string
  name?: string
  label?: string
  method?: string
  status?: { status?: string }
}

interface IntegrationInfo {
  id: string
  name: string
  connections: Connection[]
}

interface IntegrationList {
  data?: IntegrationInfo[]
}

interface ResolvedCredential {
  type: "key" | "oauth" | "external"
  key?: string
  access?: string
  expires?: number
  metadata?: Record<string, unknown>
}

export interface DiscoveryContext {
  integration: {
    list(): Promise<IntegrationList>
    connection: {
      resolve(connection: Connection): Promise<ResolvedCredential | undefined>
    }
  }
}

export const GO_INTEGRATION_ID = "opencode-go"

export async function discoverAccounts(ctx: DiscoveryContext): Promise<Account[]> {
  const result = await ctx.integration.list()
  const integrations = result.data ?? []
  const accounts: Account[] = []
  const seen = new Set<string>()
  const seenOrg = new Set<string>()

  const add = (account: Account) => {
    if (account.orgID) {
      if (seenOrg.has(account.orgID)) return
      seenOrg.add(account.orgID)
    }
    const fingerprint = createHash("sha256").update(account.token).digest("hex").slice(0, 16)
    if (seen.has(fingerprint)) return
    seen.add(fingerprint)
    accounts.push(account)
  }

  for (const integration of integrations) {
    if (integration.id !== GO_INTEGRATION_ID) continue
    for (const connection of integration.connections) {
      if (connection.status?.status === "needs_auth") continue
      if (connection.type !== "credential" && connection.type !== "env") continue
      const resolved = await ctx.integration.connection.resolve(connection)
      if (!resolved) continue
      if (resolved.type === "key" && resolved.key) {
        add({
          id: connection.type === "credential" ? connection.id ?? `credential:${connection.label}` : `env:${connection.name}`,
          label: connection.type === "credential" ? connection.label || "OpenCode Go" : `Environment ${connection.name}`,
          method: "key",
          token: resolved.key,
          keyHint: `...${resolved.key.slice(-4)}`,
          source: connection.type,
        })
      } else if (resolved.type === "oauth" && resolved.access) {
        add({
          id: `console:${connection.id ?? connection.label}`,
          label: connection.label || "OpenCode Console",
          method: "oauth",
          token: resolved.access,
          ...(orgID(resolved) ? { orgID: orgID(resolved)! } : {}),
          ...(resolved.expires ? { expires: normalizeExpiry(resolved.expires) } : {}),
          keyHint: orgID(resolved) ? `org ${orgID(resolved)!.slice(-6)}` : "...oauth",
          source: "credential",
        })
      }
    }
  }

  for (const integration of integrations) {
    if (integration.id !== "opencode") continue
    for (const connection of integration.connections) {
      if (connection.status?.status === "needs_auth") continue
      if (connection.type !== "credential" || connection.method !== "oauth") continue
      const resolved = await ctx.integration.connection.resolve(connection)
      if (!resolved || resolved.type !== "oauth" || !resolved.access) continue
      add({
        id: `console:${connection.id ?? connection.label}`,
        label: connection.label || "OpenCode Console",
        method: "oauth",
        token: resolved.access,
        ...(orgID(resolved) ? { orgID: orgID(resolved)! } : {}),
        ...(resolved.expires ? { expires: normalizeExpiry(resolved.expires) } : {}),
        keyHint: orgID(resolved) ? `org ${orgID(resolved)!.slice(-6)}` : "...oauth",
        source: "credential",
      })
    }
  }

  return accounts
}

function orgID(value: ResolvedCredential) {
  const id = value.metadata?.orgID
  return typeof id === "string" ? id : undefined
}

function normalizeExpiry(value: number) {
  return value < 10_000_000_000 ? value * 1000 : value
}
