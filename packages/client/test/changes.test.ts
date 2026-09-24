import { expect, test } from "bun:test"

import type { ChangeWireDto, RepositoryViewDto } from "@corvi/contracts/api"
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

test("terminalActions lists what a change may run", async () => {
  const urls: string[] = []
  const client = makeChangesClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input) => {
      urls.push(String(input))
      return Response.json([
        { key: "builtin:brief", label: "Send PLAN.md instructions", kind: "prompt", target: "agent", source: "builtin" },
      ])
    },
  })
  const actions = await client.terminalActions(ChangeId.make("demo"))
  expect(urls).toEqual(["http://127.0.0.1:4000/api/changes/demo/terminal/actions"])
  expect(actions.map((a) => a.key)).toEqual(["builtin:brief"])
})

test("runAction names the action and the window — and never any text", async () => {
  const sent: { url: string; body: unknown } = { url: "", body: undefined }
  const client = makeChangesClient({
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
  const result = await client.runAction(ChangeId.make("demo"), "global:review", "@2")
  expect(sent.url).toBe("http://127.0.0.1:4000/api/changes/demo/terminal/actions")
  // The wire carries the key and the window: the text stays on the machine.
  expect(sent.body).toEqual({ key: "global:review", window: "@2" })
  expect(result.window?.label).toBe("pi working")
})

// The file routes are named without the `/api` the transport adds — a doubled prefix would ask
// a path the server has never had, and only a real round trip would notice.
test("the action files' routes go through the one /api the transport adds", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const listing = { workspaces: [{ id: "w", name: "Work" }], files: [] }
  const client = makeChangesClient({
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

  expect(await client.actionFiles()).toEqual(listing)
  const file = { scope: "global" as const, id: "say-hi", text: "---\nlabel: Hi\nkind: prompt\n---\nhello\n" }
  expect(await client.writeActionFile(file)).toEqual(listing)
  expect(
    await client.deleteActionFile({ scope: "workspace", workspace: "w", id: "say-hi" }),
  ).toEqual(listing)

  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET http://127.0.0.1:4000/api/actions/files",
    "PUT http://127.0.0.1:4000/api/actions/files",
    "DELETE http://127.0.0.1:4000/api/actions/files?scope=workspace&workspace=w&id=say-hi",
  ])
  expect(calls[1]?.body).toEqual(file)
})

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

const change = (id: string): ChangeWireDto => ({
  id,
  branch: id,
  checkouts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
})

test("the change reads hit their named paths and decode their payloads", async () => {
  const calls: string[] = []
  const client = makeChangesClient({
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
      if (url.endsWith("/integrations"))
        return Response.json([{ name: "git", title: "Local changes", perRepo: false, column: "right", editable: true }])
      if (url.endsWith("/tabs"))
        return Response.json({ tabs: [{ id: "review", title: "Review changes", extension: "review" }] })
      if (url.endsWith("/widgets"))
        return Response.json({
          widgets: [{ id: "notes", title: "Notes", extension: "notes", column: "left" }],
        })
      if (url.endsWith("/repos"))
        return Response.json([{ path: "/r", name: "r", location: "new", branch: { kind: "change" } }])
      if (url.endsWith("/description")) return Response.json({ text: "PROJ - thing" })
      if (url.endsWith("/plan")) return Response.json({ text: "the plan", revision: "r1" })
      return Response.json(change("a"))
    },
  })

  expect(await client.list()).toHaveLength(2)
  expect((await client.read(ChangeId.make("a"))).id).toBe("a")
  expect((await client.summary(ChangeId.make("a"))).state).toBe("none")
  expect((await client.cards(ChangeId.make("a")))[0]?.name).toBe("git")
  expect((await client.cards(ChangeId.make("a")))[0]?.editable).toBe(true)
  expect((await client.tabs(ChangeId.make("a")))[0]?.id).toBe("review")
  expect((await client.widgets(ChangeId.make("a")))[0]?.column).toBe("left")
  expect((await client.repoStates(ChangeId.make("a")))[0]?.path).toBe("/r")
  expect((await client.description(ChangeId.make("a"))).text).toBe("PROJ - thing")
  expect(await client.plan(ChangeId.make("a"))).toEqual({ text: "the plan", revision: "r1" })
  expect(calls[0]).toBe("http://x/api/changes")
})

test("writePlan sends the text and its base revision to the plan endpoint", async () => {
  let seen: { url: string; init?: RequestInit } | undefined
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      seen = { url: String(input), init }
      return Response.json({ text: "saved", revision: "r2" })
    },
  })

  expect(await client.writePlan(ChangeId.make("a"), { text: "saved", baseRevision: "r1" })).toEqual({
    text: "saved",
    revision: "r2",
  })
  expect(seen?.url).toBe("http://x/api/changes/a/plan")
  expect(seen?.init?.method).toBe("PUT")
  expect(JSON.parse(String(seen?.init?.body))).toEqual({ text: "saved", baseRevision: "r1" })
})

test("a card, its repository rows, and the completion state decode", async () => {
  let progress = 0
  const calls: string[] = []
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("/complete/progress"))
        return Response.json(
          progress++ === 0
            ? { startedAt: "t", steps: [{ id: "check", label: "check", state: "running" }] }
            : null,
        )
      if (url.includes("/complete"))
        return Response.json({ ready: true, reasons: [], tagged: [], toMerge: [] })
      if (url.includes("/repo?path="))
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

  const widget = await client.card(ChangeId.make("a"), "git")
  expect(widget.integration).toBe("git")
  // The rows are recursive: a child row decodes under its parent.
  expect(widget.items[0]?.children?.[0]?.label).toBe("c")
  expect((await client.cardRepo(ChangeId.make("a"), "git", "/repos/r")).items[0]?.state).toBe("ok")
  expect((await client.completion(ChangeId.make("a"))).ready).toBe(true)
  expect((await client.completionProgress(ChangeId.make("a")))?.steps[0]?.state).toBe("running")
  expect(await client.completionProgress(ChangeId.make("a"))).toBeNull()
  expect(calls.some((url) => url.endsWith("/changes/a/git"))).toBe(true)
  expect(calls.some((url) => url.endsWith("?path=%2Frepos%2Fr"))).toBe(true)
})

test("terminals, wizard steps, pages and the directory browser decode", async () => {
  const calls: string[] = []
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/api/terminals"))
        return Response.json({
          a: [
            {
              index: 0,
              id: "@1",
              label: "l",
              detail: "d",
              attention: false,
              active: true,
              activity: false,
            },
          ],
        })
      if (url.endsWith("/changes/a/terminal")) return Response.json({ url: "/term/a" })
      if (url.includes("/api/wizard"))
        return Response.json({
          steps: [{ id: "jira", extension: "jira", title: "Jira", phase: "issue" }],
          planTemplate: "# Template",
        })
      if (url.includes("/api/pages"))
        return Response.json({
          pages: [{ id: "leftovers", title: "Leftovers", extension: "leftovers" }],
        })
      if (url.includes("/api/repos/branches"))
        return Response.json({ branches: ["main", "dev"], default: "main" })
      return Response.json({
        path: "/repos",
        entries: [{ path: "/repos/x", name: "x", isRepo: true }],
      })
    },
  })

  expect((await client.terminals()).a?.[0]?.attention).toBe(false)
  expect((await client.terminalUrl(ChangeId.make("a"))).url).toBe("/term/a")
  const wizard = await client.wizard("w")
  expect(wizard.steps[0]?.phase).toBe("issue")
  expect(wizard.planTemplate).toBe("# Template")
  expect((await client.pages("w"))[0]?.id).toBe("leftovers")
  expect((await client.branches("/repos/x")).default).toBe("main")
  expect((await client.directories({ path: "/repos", hidden: true })).entries[0]?.isRepo).toBe(true)
  expect(calls.some((url) => url.endsWith("/api/repos?path=%2Frepos&hidden=1"))).toBe(true)
  expect(calls.some((url) => url.endsWith("/api/wizard?workspace=w"))).toBe(true)
})

test("the settings view and the workspaces decode", async () => {
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
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      if (String(input).endsWith("/api/workspaces"))
        return Response.json({ workspaces: [{ id: "demo", name: "Demo" }], platform: "linux" })
      return Response.json(view)
    },
  })

  expect((await client.settings()).effective.contextMenu).toBe(true)
  expect((await client.workspaces()).platform).toBe("linux")
  expect((await client.workspaces()).workspaces[0]?.id).toBe("demo")
  expect(await client.writeSettings({ changesRoot: "/c" })).toEqual(view)
  expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/api/settings"))).toBe(true)
})

test("a structured refusal carries its body on the error", async () => {
  const refusal = { reasons: [{ text: "no pull request", kind: "forceable" }], toMerge: [] }
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async () => Response.json(refusal, { status: 409 }),
  })
  const failure = await client.complete(ChangeId.make("a")).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).status).toBe(409)
  expect((failure as ClientError).body).toEqual(refusal)
})

test("the write operations decode their responses", async () => {
  const calls: { url: string; method?: string }[] = []
  const change = (id: string): ChangeWireDto => ({ id, branch: id, checkouts: [], createdAt: "t" })
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith("/complete")) return Response.json({ change: change("a"), notes: ["done"] })
      if (url.endsWith("/repos")) return Response.json(change("a"))
      if (url.includes("/git/add")) return Response.json({ items: [{ label: "r" }] })
      return Response.json({ change: change("a"), provision: [{ integration: "git", ok: true }] })
    },
  })

  expect((await client.complete(ChangeId.make("a"), { force: true })).notes).toEqual(["done"])
  expect((await client.start(ChangeId.make("a"))).provision[0]?.integration).toBe("git")
  expect(
    (
      await client.setRepositories(ChangeId.make("a"), {
        checkouts: [{ path: "/r", location: "new", branch: { kind: "change" } }],
      })
    ).id,
  ).toBe("a")
  expect(
    (await client.cardRepoAction(ChangeId.make("a"), "git", "add", "/r")).items[0]?.label,
  ).toBe("r")
  expect(calls.some((call) => call.method === "PATCH")).toBe(false)
})

test("a response that is not JSON is read as an out-of-date server, not a parse error", async () => {
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async () =>
      new Response("<html>the app</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  })
  const failure = await client.settings().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ClientError)
  expect((failure as ClientError).message).toContain("the server has no /settings")
})

test("a JSON error without an error field falls back to the status text", async () => {
  const client = makeChangesClient({
    baseUrl: "http://x",
    fetch: async () =>
      new Response(JSON.stringify({ detail: "no message" }), {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  })
  const failure = await client.list().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect((failure as ClientError).message).toBe("Internal Server Error")
  expect((failure as ClientError).body).toEqual({ detail: "no message" })
})
