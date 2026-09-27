/** The change's own operations: the server and the client agree on the encoding of every read
 * and write the change lifecycle, its documents and its completion use. */
import { expect, test } from "bun:test"

import type { ChangeWireDto, RepositoryViewDto } from "@corvi/contracts/api"
import { ChangeId, DirectoryName, RepositoryId } from "@corvi/contracts/changes"
import { makeCorviClient } from "../src/index.ts"

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
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input) => {
      urls.push(String(input))
      return Response.json(payload)
    },
  })
  const views = await client.changes.inspectRepositories(ChangeId.make("demo"))
  expect(urls).toEqual(["http://127.0.0.1:4000/api/changes/demo/checkouts"])
  expect(views).toEqual(payload)
})

const change = (id: string): ChangeWireDto => ({
  id,
  branch: id,
  checkouts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
})

test("the change reads hit their named paths and decode their payloads", async () => {
  const calls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://x/",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/api/changes")) return Response.json([change("a"), change("b")])
      if (url.endsWith("/summary"))
        return Response.json({
          facts: [{ id: "terminals", label: "terminals idle", state: "none" }],
          state: "none",
        })
      if (url.endsWith("/description")) return Response.json({ text: "PROJ - thing" })
      if (url.endsWith("/plan")) return Response.json({ text: "the plan", revision: "r1" })
      return Response.json(change("a"))
    },
  })

  expect(await client.changes.list()).toHaveLength(2)
  expect((await client.changes.read(ChangeId.make("a"))).id).toBe("a")
  expect((await client.changes.summary(ChangeId.make("a"))).state).toBe("none")
  expect((await client.changes.description(ChangeId.make("a"))).text).toBe("PROJ - thing")
  expect(await client.changes.plan(ChangeId.make("a"))).toEqual({ text: "the plan", revision: "r1" })
  expect(calls[0]).toBe("http://x/api/changes")
})

test("writePlan sends the text and its base revision to the plan endpoint", async () => {
  let seen: { url: string; init?: RequestInit } | undefined
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      seen = { url: String(input), init }
      return Response.json({ text: "saved", revision: "r2" })
    },
  })

  expect(
    await client.changes.writePlan(ChangeId.make("a"), { text: "saved", baseRevision: "r1" }),
  ).toEqual({
    text: "saved",
    revision: "r2",
  })
  expect(seen?.url).toBe("http://x/api/changes/a/plan")
  expect(seen?.init?.method).toBe("PUT")
  expect(JSON.parse(String(seen?.init?.body))).toEqual({ text: "saved", baseRevision: "r1" })
})

test("the completion state and its progress decode", async () => {
  let progress = 0
  const calls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/completion/progress"))
        return Response.json(
          progress++ === 0
            ? { startedAt: "t", steps: [{ id: "check", label: "check", state: "running" }] }
            : null,
        )
      return Response.json({ ready: true, reasons: [], tagged: [], toMerge: [] })
    },
  })

  expect((await client.changes.completion(ChangeId.make("a"))).ready).toBe(true)
  expect((await client.changes.completionProgress(ChangeId.make("a")))?.steps[0]?.state).toBe(
    "running",
  )
  expect(await client.changes.completionProgress(ChangeId.make("a"))).toBeNull()
  expect(calls.every((url) => url.endsWith("/completion") || url.endsWith("/completion/progress")))
    .toBe(true)
})

test("the write operations decode their responses", async () => {
  const calls: { url: string; method?: string }[] = []
  const change = (id: string): ChangeWireDto => ({ id, branch: id, checkouts: [], createdAt: "t" })
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith("/complete")) return Response.json({ change: change("a"), notes: ["done"] })
      if (url.endsWith("/repos")) return Response.json(change("a"))
      return Response.json({ change: change("a"), provision: [{ integration: "git", ok: true }] })
    },
  })

  expect((await client.changes.complete(ChangeId.make("a"), { force: true })).notes).toEqual([
    "done",
  ])
  expect((await client.changes.start(ChangeId.make("a"))).provision[0]?.integration).toBe("git")
  expect(
    (
      await client.changes.setRepositories(ChangeId.make("a"), {
        checkouts: [{ path: "/r", location: "new", branch: { kind: "change" } }],
      })
    ).id,
  ).toBe("a")
  expect(calls.some((call) => call.method === "PATCH")).toBe(false)
})
