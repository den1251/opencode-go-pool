import { describe, expect, test } from "bun:test"
import { applyAuthorization, authorizationHeaders } from "../src/auth"
import { account } from "./helpers"

describe("authorization", () => {
  test("builds key and oauth headers", () => {
    expect(authorizationHeaders(account())).toEqual({ authorization: "Bearer oc_sk_one_1234" })
    expect(authorizationHeaders(account({ orgID: "org_1" }))).toEqual({
      authorization: "Bearer oc_sk_one_1234",
      "x-opencode-org-id": "org_1",
    })
  })

  test("replaces auth without touching other headers", () => {
    const headers = new Headers({
      authorization: "Bearer old",
      "x-opencode-org-id": "old-org",
      "content-type": "application/json",
    })
    applyAuthorization(headers, account({ token: "new-token" }))
    expect(headers.get("authorization")).toBe("Bearer new-token")
    expect(headers.get("x-opencode-org-id")).toBeNull()
    expect(headers.get("content-type")).toBe("application/json")
  })

  test("sets the org header for oauth", () => {
    const headers = new Headers()
    applyAuthorization(headers, account({ orgID: "org_2" }))
    expect(headers.get("x-opencode-org-id")).toBe("org_2")
  })
})
