import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import {
  AgentTranscripts,
  isWithin,
  parseOpencodeExport,
  parsePiSession,
  piSessionDirectoryName,
} from "../src/transcripts.ts"
import { piSessionRoots, transcriptsLayer, type OpencodeCli } from "../src/node/transcripts.ts"

const inTemp = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-transcripts-`))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const piSession = (cwd: string, id: string, said: string): string =>
  [
    { type: "session", version: 3, id, timestamp: "2026-11-01T10:00:00.000Z", cwd },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-01T10:00:01.000Z", provider: "deepseek", modelId: "flash" },
    {
      type: "message",
      id: "s1",
      parentId: "m1",
      timestamp: "2026-11-01T10:00:01.000Z",
      message: { role: "system", content: "", timestamp: 1 },
    },
    {
      type: "message",
      id: "u1",
      parentId: "s1",
      timestamp: "2026-11-01T10:00:02.000Z",
      message: { role: "user", content: [{ type: "text", text: said }], timestamp: 2 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-11-01T10:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me look." },
          { type: "text", text: "Reading the plan." },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "PLAN.md" } },
        ],
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-11-01T10:00:04.000Z",
      message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "# Plan" }], isError: false, timestamp: 4 },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n"

test("pi's session directory is the path with its separators turned into dashes", () => {
  expect(piSessionDirectoryName("/home/me/corvi/changes/fix-it")).toBe("--home-me-corvi-changes-fix-it--")
  expect(isWithin("/a/b", "/a/b")).toBe(true)
  expect(isWithin("/a/b", "/a/b/c")).toBe(true)
  expect(isWithin("/a/b", "/a/bc")).toBe(false)
})

test("a pi session reads as a conversation: what was said, thought, called and answered", () => {
  const transcript = parsePiSession(piSession("/changes/x", "s-1", "Please refine the plan"), { id: "pi/a.jsonl", where: "" })
  expect(transcript.summary).toMatchObject({
    harness: "pi",
    sessionId: "s-1",
    cwd: "/changes/x",
    title: "Please refine the plan",
    startedAt: "2026-11-01T10:00:00.000Z",
  })
  expect(transcript.entries.map((entry) => entry._tag)).toEqual([
    "Note",
    "Message",
    "Thinking",
    "Message",
    "ToolCall",
    "ToolResult",
  ])
  expect(transcript.entries[4]).toMatchObject({ _tag: "ToolCall", name: "read" })
  expect(transcript.entries[5]).toMatchObject({ _tag: "ToolResult", output: "# Plan", error: false })
})

test("an opencode export reads as a conversation", () => {
  const exported = JSON.stringify({
    info: { id: "ses_1", title: "Greeting", time: { created: 1790633002024 }, location: { directory: "/changes/x" } },
    messages: [
      { id: "m1", time: { created: 1790633002495 }, text: "hi", type: "user" },
      { id: "m2", time: { created: 1790633002514 }, type: "assistant", content: [{ type: "text", text: "Hello!" }] },
    ],
  })
  const transcript = parseOpencodeExport(exported, { id: "opencode/ses_1.json", where: "" })
  expect(transcript.summary).toMatchObject({ harness: "opencode", sessionId: "ses_1", cwd: "/changes/x", title: "Greeting" })
  expect(transcript.entries).toMatchObject([
    { _tag: "Message", role: "user", text: "hi" },
    { _tag: "Message", role: "assistant", text: "Hello!" },
  ])
})

test("collecting copies the sessions that ran in the change and below it — and not a change whose name only starts the same", () =>
  inTemp(async (root) => {
    const sessions = join(root, "pi-sessions")
    const change = join(root, "changes", "fix")
    const write = async (cwd: string, file: string, said: string): Promise<string> => {
      const dir = join(sessions, piSessionDirectoryName(cwd))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), piSession(cwd, file, said))
      return join(dir, file)
    }
    const own = await write(change, "1_own.jsonl", "the change's own")
    await write(join(change, "corvi"), "2_worktree.jsonl", "in the worktree")
    await write(join(change, "subagents", "reviewer-1"), "3_subagent.jsonl", "a reviewer")
    // `fix-more` shares the prefix `--…-fix-`: its header says it is somebody else's.
    await write(`${change}-more`, "4_other.jsonl", "another change")
    await mkdir(change, { recursive: true })

    const opencode: OpencodeCli = {
      listSessions: (cwd) => Effect.succeed(cwd === change ? JSON.stringify([{ id: "ses_a" }, { id: "ses_elsewhere" }]) : "[]"),
      exportSession: (id) =>
        Effect.succeed(
          JSON.stringify({
            info: { id, location: { directory: id === "ses_a" ? change : "/somewhere/else" } },
            messages: [{ type: "user", text: "hello" }],
          }),
        ),
    }
    const to = join(change, "transcripts")
    const program = Effect.gen(function* () {
      const transcripts = yield* AgentTranscripts
      const collected = yield* transcripts.collect({ from: AbsolutePath.make(change), to: AbsolutePath.make(to) })
      // Idempotent: a second collection replaces the copies rather than adding to them.
      yield* transcripts.collect({ from: AbsolutePath.make(change), to: AbsolutePath.make(to) })
      const listed = yield* transcripts.list(AbsolutePath.make(to))
      const one = yield* transcripts.read(AbsolutePath.make(to), "pi/subagents/reviewer-1/3_subagent.jsonl")
      const escape = yield* transcripts.read(AbsolutePath.make(to), "../change.json").pipe(Effect.result)
      return { collected, listed, one, escape }
    })
    const { collected, listed, one, escape } = await Effect.runPromise(
      program.pipe(Effect.provide(transcriptsLayer({ piSessionRoots: [sessions, join(root, "absent")], opencode }))),
    )
    expect(collected).toEqual({ copied: 4, notes: [] })
    expect(listed.map((summary) => [summary.id, summary.where]).sort()).toEqual([
      ["opencode/ses_a.json", ""],
      ["pi/1_own.jsonl", ""],
      ["pi/corvi/2_worktree.jsonl", "corvi"],
      ["pi/subagents/reviewer-1/3_subagent.jsonl", "subagents/reviewer-1"],
    ])
    expect(one.summary.title).toBe("a reviewer")
    expect(escape._tag).toBe("Failure")
    // The harness's own file is only read.
    expect(await readFile(own, "utf8")).toContain("the change's own")
  }))

test("collecting for a change directory that is gone still finds pi's sessions by their header", () =>
  inTemp(async (root) => {
    const sessions = join(root, "pi-sessions")
    const gone = join(root, "changes", "old")
    const dir = join(sessions, piSessionDirectoryName(gone))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "1.jsonl"), piSession(gone, "1", "long ago"))
    const to = join(root, "archive", "old", "transcripts")
    const collected = await Effect.runPromise(
      Effect.flatMap(AgentTranscripts, (transcripts) =>
        transcripts.collect({ from: AbsolutePath.make(gone), to: AbsolutePath.make(to) }),
      ).pipe(Effect.provide(transcriptsLayer({ piSessionRoots: [sessions] }))),
    )
    expect(collected.copied).toBe(1)
    expect(await readFile(join(to, "pi", "1.jsonl"), "utf8")).toContain("long ago")
  }))

test("pi's session roots follow its environment and settings", () =>
  inTemp(async (root) => {
    const agent = join(root, "agent")
    await mkdir(agent, { recursive: true })
    await writeFile(join(agent, "settings.json"), JSON.stringify({ sessionDir: "~/elsewhere" }))
    const roots = await Effect.runPromise(
      piSessionRoots({ PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: "/explicit" }, "/home/me"),
    )
    expect(roots).toEqual(["/explicit", "/home/me/elsewhere", join(agent, "sessions")])
    const defaults = await Effect.runPromise(piSessionRoots({}, root))
    expect(defaults).toEqual([join(root, ".pi", "agent", "sessions")])
  }))
