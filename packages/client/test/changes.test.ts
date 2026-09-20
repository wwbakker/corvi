import { expect, test } from "bun:test"

import type { RepositoryViewDto } from "@corvi/contracts/api"
import { ChangeId, DirectoryName, RepositoryId } from "@corvi/contracts/changes"
import { ClientError, makeChangesClient } from "../src/changes.ts"

const payload: readonly RepositoryViewDto[] = [
  {
    repositoryId: RepositoryId.make("demo:repo"),
    directoryName: DirectoryName.make("repo"),
    state: "Active",
    checkoutLocation: "/changes/demo/repo",
    checkout: { _tag: "Present", branch: "demo", head: "abc" },
  },
  {
    repositoryId: RepositoryId.make("demo:other"),
    directoryName: DirectoryName.make("other"),
    state: "Active",
    checkoutLocation: "/sources/other",
    checkout: { _tag: "Missing" },
  },
]

test("inspectRepositories decodes the server payload", async () => {
  const urls: string[] = []
  const client = makeChangesClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input) => {
      urls.push(String(input))
      return Response.json(payload)
    },
  })
  const views = await client.inspectRepositories(ChangeId.make("demo"))
  expect(urls).toEqual(["http://127.0.0.1:4000/api/changes/demo/repositories"])
  expect(views).toEqual(payload)
})

test("a failed request is a classified ClientError with the status", async () => {
  const client = makeChangesClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async () => new Response(JSON.stringify({ error: "change not found" }), { status: 404 }),
  })
  const failure = await client.inspectRepositories(ChangeId.make("absent")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).status).toBe(404)
})

test("an unreachable server is a classified ClientError", async () => {
  const client = makeChangesClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async () => {
      throw new Error("connection refused")
    },
  })
  const failure = await client.inspectRepositories(ChangeId.make("demo")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).status).toBeUndefined()
})

test("a payload the schema does not accept is rejected, not trusted", async () => {
  const client = makeChangesClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async () => Response.json([{ repositoryId: "demo:repo" }]),
  })
  const failure = await client.inspectRepositories(ChangeId.make("demo")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeDefined()
  expect(failure).not.toBeInstanceOf(ClientError)
})
