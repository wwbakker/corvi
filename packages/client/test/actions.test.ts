/** The actions operations: what a change may run, running one by key, and the action files —
 * each names its route, and the wire never carries an action's text. */
import { expect, test } from "bun:test"

import { ChangeId } from "@corvi/contracts/changes"
import { makeCorviClient } from "../src/index.ts"

test("terminalActions lists what a change may run", async () => {
  const urls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input) => {
      urls.push(String(input))
      return Response.json([
        {
          key: "builtin:brief",
          label: "Send PLAN.md instructions",
          kind: "prompt",
          target: "agent",
          source: "builtin",
        },
      ])
    },
  })
  const actions = await client.actions.terminalActions(ChangeId.make("demo"))
  expect(urls).toEqual(["http://127.0.0.1:4000/api/changes/demo/actions"])
  expect(actions.map((a) => a.key)).toEqual(["builtin:brief"])
})

test("runAction names the action and the window — and never any text", async () => {
  const sent: { url: string; body: unknown } = { url: "", body: undefined }
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input, init) => {
      sent.url = String(input)
      sent.body = JSON.parse(String(init?.body))
      return Response.json({
        kind: "prompt",
        submitted: false,
        started: false,
        window: { id: "@2", label: "pi working" },
      })
    },
  })
  const result = await client.actions.runAction(ChangeId.make("demo"), "global:review", "@2")
  expect(sent.url).toBe("http://127.0.0.1:4000/api/changes/demo/actions")
  // The wire carries the key and the window: the text stays on the machine.
  expect(sent.body).toEqual({ key: "global:review", window: "@2" })
  expect(result.window?.label).toBe("pi working")
})

// The file routes are named without the `/api` the transport adds — a doubled prefix would ask
// a path the server has never had, and only a real round trip would notice.
test("the action files' routes go through the one /api the transport adds", async () => {
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

  expect(await client.actions.actionFiles()).toEqual(listing)
  const file = {
    scope: "global" as const,
    id: "say-hi",
    text: "---\nlabel: Hi\nkind: prompt\n---\nhello\n",
  }
  expect(await client.actions.writeActionFile(file)).toEqual(listing)
  expect(
    await client.actions.deleteActionFile({ scope: "workspace", workspace: "w", id: "say-hi" }),
  ).toEqual(listing)

  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET http://127.0.0.1:4000/api/actions/files",
    "PUT http://127.0.0.1:4000/api/actions/files",
    "DELETE http://127.0.0.1:4000/api/actions/files?scope=workspace&workspace=w&id=say-hi",
  ])
  expect(calls[1]?.body).toEqual(file)
})
