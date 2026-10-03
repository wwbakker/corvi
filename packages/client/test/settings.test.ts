/** The settings operations: the view and its file decode as the server encodes them. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("the settings view decodes, and writing it names the settings route", async () => {
  const calls: { url: string; method?: string }[] = []
  const view = {
    path: "/cfg/config.json",
    file: {},
    effective: {
      changesRoot: "/changes",
      archiveRoot: "/archive",
      repositoriesDirectory: "/repos",
      notificationSound: true,
      contextMenu: true,
      ideationPrompt: "p",
      planTemplate: "# Template",
      workspaces: [],
      worktreeCopy: [],
      env: {},
      devices: [],
    },
    overridden: {},
    overriddenExtensions: {},
    toolingDefault: [".idea"],
    extensions: [
      {
        name: "jira",
        title: "Jira",
        settings: [{ key: "site", label: "Site" }],
      },
    ],
  }
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      return Response.json(view)
    },
  })

  expect((await client.settings.read()).effective.contextMenu).toBe(true)
  expect(await client.settings.write({ changesRoot: "/c" })).toEqual(view)
  expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/api/settings"))).toBe(
    true,
  )
})
