import type { Account } from "./types"

export function authorizationHeaders(account: Account): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${account.token}` }
  if (account.orgID) headers["x-opencode-org-id"] = account.orgID
  return headers
}

export function applyAuthorization(headers: Headers, account: Account) {
  headers.set("authorization", `Bearer ${account.token}`)
  if (account.orgID) {
    headers.set("x-opencode-org-id", account.orgID)
    headers.set("x-org-id", account.orgID)
  } else {
    headers.delete("x-opencode-org-id")
    headers.delete("x-org-id")
  }
}

export function sameOriginURL(url: string | URL, upstream: string, target: string) {
  const source = new URL(url)
  const base = new URL(upstream)
  if (source.origin !== base.origin) return source.toString()
  return new URL(source.pathname + source.search, target).toString()
}
