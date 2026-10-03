/** The subagents operations: the profile files and the instance lifecycle each name their route,
 * the idempotency key rides along as a header, and the wire never carries more than it should. */
import { expect, test } from "bun:test"

import { ChangeId } from "@corvi/contracts/changes"
import type { SubagentInstanceDto, SubagentMessageDto } from "@corvi/contracts/subagents"
import { makeCorviClient } from "../src/index.ts"

const instance: SubagentInstanceDto = {
  id: "s1",
  changeId: "demo",
  profile: "builtin:reviewer",
  label: "Reviewer",
  harness: "pi",
  createdBy: "orchestrator",
  createdAt: "2026-01-01T00:00:00.000Z",
  presence: "attached",
  activity: "idle",
  interrupted: false,
  awaitingReply: false,
  log: [],
  messages: [],
}

const message: SubagentMessageDto = {
  number: 2,
  role: "subagent",
  at: "2026-01-01T00:00:01.000Z",
  body: "done",
}

test("the profile files' routes go through the one /api the transport adds", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const listing = { workspaces: [{ id: "w", name: "Work" }], files: [] }
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000",
    fetch: async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      })
      return Response.json(listing)
    },
  })

  expect(await client.subagents.files()).toEqual(listing)
  const file = { scope: "global" as const, id: "reviewer", text: "---\nlabel: R\n---\nreview\n" }
  expect(await client.subagents.writeFile(file)).toEqual(listing)
  expect(
    await client.subagents.deleteFile({ scope: "workspace", workspace: "w", id: "reviewer" }),
  ).toEqual(listing)

  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET http://127.0.0.1:4000/api/subagents/files",
    "PUT http://127.0.0.1:4000/api/subagents/files",
    "DELETE http://127.0.0.1:4000/api/subagents/files?scope=workspace&workspace=w&id=reviewer",
  ])
  expect(calls[1]?.body).toEqual(file)
})

test("the instance lifecycle names its routes and decodes its instances", async () => {
  const calls: { method: string; url: string; headers?: Record<string, unknown> }[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(init?.headers === undefined ? {} : { headers: init.headers as Record<string, unknown> }),
      })
      return Response.json(
        String(input).endsWith("/subagents") && (init?.method ?? "GET") === "GET"
          ? { instances: [instance] }
          : instance,
      )
    },
  })

  expect((await client.subagents.list(ChangeId.make("demo")))[0]?.id).toBe("s1")
  expect((await client.subagents.read(ChangeId.make("demo"), "s1")).presence).toBe("attached")
  expect((await client.subagents.open(ChangeId.make("demo"), "s1")).activity).toBe("idle")
  expect((await client.subagents.close(ChangeId.make("demo"), "s1")).interrupted).toBe(false)
  expect((await client.subagents.create(ChangeId.make("demo"), { profile: "builtin:reviewer" })).profile).toBe(
    "builtin:reviewer",
  )

  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET http://x/api/changes/demo/subagents",
    "GET http://x/api/changes/demo/subagents/s1",
    "POST http://x/api/changes/demo/subagents/s1/open",
    "POST http://x/api/changes/demo/subagents/s1/close",
    "POST http://x/api/changes/demo/subagents",
  ])
  // A create without a key sends no idempotency key: the transport adds one only when asked.
  expect(calls[4]?.headers?.["idempotency-key"]).toBeUndefined()
})

test("an idempotency key rides as a header on the writes that take one", async () => {
  const calls: { url: string; headers: Record<string, unknown>; body: unknown }[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, unknown>,
        body: JSON.parse(String(init?.body)),
      })
      return Response.json(message)
    },
  })

  await client.subagents.send(ChangeId.make("demo"), "s1", { text: "go" }, "key-1")
  await client.subagents.turn(ChangeId.make("demo"), "s1", { text: "done" }, "key-2")
  await client.subagents.send(ChangeId.make("demo"), "s1", { text: "again" })

  expect(calls.map((c) => c.url)).toEqual([
    "http://x/api/changes/demo/subagents/s1/messages",
    "http://x/api/changes/demo/subagents/s1/turn",
    "http://x/api/changes/demo/subagents/s1/messages",
  ])
  // The key turns a retry into the same request rather than a second message.
  expect(calls[0]?.headers["idempotency-key"]).toBe("key-1")
  expect(calls[1]?.headers["idempotency-key"]).toBe("key-2")
  expect(calls[2]?.headers["idempotency-key"]).toBeUndefined()
  expect(calls[0]?.body).toEqual({ text: "go" })
})

test("result is a message or null, and await and next name their query", async () => {
  const calls: string[] = []
  let result: unknown = message
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/result")) return Response.json(result)
      if (url.includes("/subagents/await"))
        return Response.json({ status: "ready", id: "s1", awaitingReply: true })
      return Response.json({ status: "none" })
    },
  })

  expect((await client.subagents.result(ChangeId.make("demo"), "s1"))?.body).toBe("done")
  result = null
  expect(await client.subagents.result(ChangeId.make("demo"), "s1")).toBeNull()

  expect((await client.subagents.await(ChangeId.make("demo"), {})).status).toBe("ready")
  expect((await client.subagents.await(ChangeId.make("demo"), { ids: ["s1", "s2"] })).id).toBe("s1")
  expect(
    (await client.subagents.await(ChangeId.make("demo"), { ids: ["s1"], all: true })).awaitingReply,
  ).toBe(true)
  expect((await client.subagents.next(ChangeId.make("demo"), "s1")).status).toBe("none")
  expect((await client.subagents.next(ChangeId.make("demo"), "s1", 7)).status).toBe("none")

  expect(calls).toEqual([
    "http://x/api/changes/demo/subagents/s1/result",
    "http://x/api/changes/demo/subagents/s1/result",
    "http://x/api/changes/demo/subagents/await",
    "http://x/api/changes/demo/subagents/await?id=s1&id=s2",
    "http://x/api/changes/demo/subagents/await?id=s1&all=1",
    "http://x/api/changes/demo/subagents/s1/next",
    "http://x/api/changes/demo/subagents/s1/next?after=7",
  ])
})
