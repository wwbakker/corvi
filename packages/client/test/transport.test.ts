/** The transport's classification: whatever a domain operation asks for, the failure it throws
 * is a `ClientError` the caller can act on, and a payload is never trusted as it arrives. */
import { expect, test } from "bun:test"

import { ChangeId } from "@corvi/contracts/changes"
import { ClientError, makeCorviClient } from "../src/index.ts"

test("a failed request is a classified ClientError with the status", async () => {
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async () => new Response(JSON.stringify({ error: "change not found" }), { status: 404 }),
  })
  const failure = await client.changes.inspectRepositories(ChangeId.make("absent")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).status).toBe(404)
})

test("an unreachable server is a classified ClientError", async () => {
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async () => {
      throw new Error("connection refused")
    },
  })
  const failure = await client.changes.inspectRepositories(ChangeId.make("demo")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).status).toBeUndefined()
})

test("a payload the schema does not accept is rejected, not trusted", async () => {
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async () => Response.json([{ repositoryId: "demo:repo" }]),
  })
  const failure = await client.changes.inspectRepositories(ChangeId.make("demo")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeDefined()
  expect(failure).not.toBeInstanceOf(ClientError)
})

test("a structured refusal carries its body on the error", async () => {
  const refusal = { reasons: [{ text: "no pull request", kind: "forceable" }], toMerge: [] }
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async () => Response.json(refusal, { status: 409 }),
  })
  const failure = await client.changes.complete(ChangeId.make("a")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).status).toBe(409)
  expect((failure as ClientError).body).toEqual(refusal)
})

test("a response that is not JSON is read as an out-of-date server, not a parse error", async () => {
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async () =>
      new Response("<html>the app</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  })
  const failure = await client.settings.settings().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).message).toContain("the server has no /settings")
})

test("a JSON error without an error field falls back to the status text", async () => {
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async () =>
      new Response(JSON.stringify({ detail: "no message" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  })
  const failure = await client.changes.list().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).message).toBe("Internal Server Error")
  expect((failure as ClientError).body).toEqual({ detail: "no message" })
})
