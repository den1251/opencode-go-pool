import { describe, expect, test } from "bun:test"
import { discoverAccounts } from "../src/discovery"

function context(connections: any[], resolved: Record<string, unknown>) {
  return {
    integration: {
      async list() {
        return { data: [{ id: "opencode-go", name: "OpenCode Go", connections }] }
      },
      connection: {
        async resolve(connection: { type: string; id?: string; name?: string }): Promise<any> {
          const key = connection.type === "env" ? `env:${connection.name}` : connection.id ?? ""
          return resolved[key]
        },
      },
    },
  }
}

describe("discovery", () => {
  test("discovers key, oauth and env connections", async () => {
    const accounts = await discoverAccounts(
      context(
        [
          { type: "credential", id: "cred_1", label: "Work", method: "key" },
          { type: "credential", id: "cred_2", label: "Home", method: "oauth" },
          { type: "env", name: "OPENCODE_API_KEY" },
        ],
        {
          cred_1: { type: "key", key: "oc_sk_one_1234" },
          cred_2: { type: "oauth", access: "oauth_access_9999", metadata: { orgID: "org_1" } },
          "env:OPENCODE_API_KEY": { type: "key", key: "oc_sk_env_5678" },
        },
      ),
    )
    expect(accounts).toHaveLength(3)
    expect(accounts[0]).toMatchObject({ id: "cred_1", label: "Work", method: "key", keyHint: "...1234" })
    expect(accounts[1]).toMatchObject({
      id: "console:cred_2",
      method: "oauth",
      orgID: "org_1",
      keyHint: "org org_1",
    })
    expect(accounts[2]).toMatchObject({ id: "env:OPENCODE_API_KEY", source: "env" })
  })

  test("skips missing, needs-auth, external and duplicate keys", async () => {
    const accounts = await discoverAccounts(
      context(
        [
          { type: "credential", id: "missing", label: "Missing", method: "key" },
          { type: "credential", id: "auth", label: "Needs auth", method: "key", status: { status: "needs_auth" } },
          { type: "credential", id: "ext", label: "External", method: "external" },
          { type: "credential", id: "one", label: "One", method: "key" },
          { type: "credential", id: "dupe", label: "Dupe", method: "key" },
        ],
        {
          auth: { type: "key", key: "oc_sk_auth_1111" },
          ext: { type: "external" },
          one: { type: "key", key: "oc_sk_same_2222" },
          dupe: { type: "key", key: "oc_sk_same_2222" },
        },
      ),
    )
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe("one")
  })

  test("discovers Console accounts used for Go", async () => {
    const accounts = await discoverAccounts({
      integration: {
        async list() {
          return {
            data: [
              { id: "opencode-go", name: "OpenCode Go", connections: [] },
              {
                id: "opencode",
                name: "OpenCode Console",
                connections: [
                  { type: "credential", id: "cred_c1", label: "Personal", method: "oauth" },
                  { type: "credential", id: "cred_c2", label: "Personal 2", method: "oauth" },
                  { type: "credential", id: "cred_c3", label: "Duplicate workspace", method: "oauth" },
                  { type: "credential", id: "cred_key", label: "API Key", method: "key" },
                ],
              },
            ],
          }
        },
        connection: {
          async resolve(connection: { id?: string }): Promise<any> {
            if (connection.id === "cred_c1") {
              return { type: "oauth", access: "console_access_1111", expires: Date.now() + 60_000, metadata: { orgID: "org_one" } }
            }
            if (connection.id === "cred_c2") {
              return { type: "oauth", access: "console_access_2222", expires: Date.now() + 60_000, metadata: { orgID: "org_two" } }
            }
            if (connection.id === "cred_c3") {
              return { type: "oauth", access: "console_access_3333", expires: Date.now() + 60_000, metadata: { orgID: "org_one" } }
            }
            return { type: "key", key: "not_go" }
          },
        },
      },
    })
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      id: "console:cred_c1",
      label: "Personal",
      method: "oauth",
      orgID: "org_one",
      keyHint: "org rg_one",
    })
    expect(accounts[1]?.orgID).toBe("org_two")
  })

  test("returns nothing when the integration is absent", async () => {
    const accounts = await discoverAccounts({
      integration: {
        async list() {
          return { data: [] }
        },
        connection: { async resolve() {} },
      },
    })
    expect(accounts).toEqual([])
  })
})
