/** The dashboard operations: the server and the client agree on the encoding of the cards, their
 * widgets and their per-repository rows. */
import { expect, test } from "bun:test"

import { ChangeId } from "@corvi/contracts/changes"
import { makeCorviClient } from "../src/index.ts"

test("the dashboard reads hit their named paths and decode their payloads", async () => {
  const client = makeCorviClient({
    baseUrl: "http://x/",
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith("/cards"))
        return Response.json([
          { name: "git", title: "Local changes", perRepo: false, column: "right", editable: true },
        ])
      if (url.endsWith("/tabs"))
        return Response.json({
          tabs: [{ id: "review", title: "Review changes", extension: "review" }],
        })
      if (url.endsWith("/widgets"))
        return Response.json({
          widgets: [{ id: "notes", title: "Notes", extension: "notes", column: "left" }],
        })
      return Response.json({ integration: "git", title: "", state: "none", summary: "", items: [] })
    },
  })

  expect((await client.dashboard.cards(ChangeId.make("a")))[0]?.name).toBe("git")
  expect((await client.dashboard.cards(ChangeId.make("a")))[0]?.editable).toBe(true)
  expect((await client.dashboard.tabs(ChangeId.make("a")))[0]?.id).toBe("review")
  expect((await client.dashboard.widgets(ChangeId.make("a")))[0]?.column).toBe("left")
})

test("a card and its repository rows decode under their card path", async () => {
  const calls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("/items?path="))
        return Response.json({ items: [{ label: "repo", state: "ok" }] })
      return Response.json({
        integration: "git",
        title: "Local changes",
        state: "none",
        summary: "",
        items: [{ label: "r", children: [{ label: "c" }] }],
      })
    },
  })

  const widget = await client.dashboard.card(ChangeId.make("a"), "git")
  expect(widget.integration).toBe("git")
  // The rows are recursive: a child row decodes under its parent.
  expect(widget.items[0]?.children?.[0]?.label).toBe("c")
  expect(
    (await client.dashboard.cardRepo(ChangeId.make("a"), "git", "/repos/r")).items[0]?.state,
  ).toBe("ok")
  expect(calls.some((url) => url.endsWith("/changes/a/cards/git"))).toBe(true)
  expect(calls.some((url) => url.endsWith("?path=%2Frepos%2Fr"))).toBe(true)
})

test("a repository action names the card, the action and its argument", async () => {
  const sent: { url: string; body: unknown } = { url: "", body: undefined }
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      sent.url = String(input)
      sent.body = JSON.parse(String(init?.body))
      return Response.json({ items: [{ label: "r" }] })
    },
  })

  expect(
    (await client.dashboard.cardRepoAction(ChangeId.make("a"), "git", "add", "/r")).items[0]
      ?.label,
  ).toBe("r")
  expect(sent.url).toBe("http://x/api/changes/a/cards/git/actions/add")
  expect(sent.body).toEqual({ arg: "/r" })
})
