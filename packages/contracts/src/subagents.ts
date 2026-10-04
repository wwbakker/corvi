/** The subagent profile vocabulary on the wire: what the Subagents page lists and edits.
 *
 * A profile is a template for a subagent instance — harness, model, effort and an initial
 * prompt. Like an action, it is one Markdown file with YAML frontmatter; the page edits the file
 * itself, so what it sends is the file's text. The profile's own parsed shape is
 * `@corvi/agents/profile`'s; this file is what the browser and the server share. */
import { Schema } from "effect"

/** The harness a profile starts. */
export const SubagentHarness = Schema.Literals(["pi", "opencode"])
export type SubagentHarness = typeof SubagentHarness.Type

/** Where the profile's file was discovered. Built-in files are shipped with Corvi; repository
 * files live in one of the change's checkouts. */
export const SubagentSource = Schema.Literals(["builtin", "global", "workspace", "repository"])
export type SubagentSource = typeof SubagentSource.Type

/** One profile file as the page lists it: the file as written, and what it parses to — or why it
 * does not, shown so it can be fixed right there. */
export const SubagentProfileFileSchema = Schema.Struct({
  scope: SubagentSource,
  /** The workspace a workspace file belongs to. */
  workspace: Schema.optional(Schema.String),
  workspaceLabel: Schema.optional(Schema.String),
  /** The repository a repository file belongs to, as its key spells it ("orders-api"). */
  repository: Schema.optional(Schema.String),
  /** The filename without `.md`: the profile's id. */
  id: Schema.String,
  path: Schema.String,
  /** Frontmatter and body together, exactly as the file is on disk. */
  text: Schema.String,
  label: Schema.optional(Schema.String),
  problems: Schema.optional(Schema.Array(Schema.String)),
})
export type SubagentProfileFileDto = typeof SubagentProfileFileSchema.Type

export const SubagentFilesResponseSchema = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  files: Schema.Array(SubagentProfileFileSchema),
})
export type SubagentFilesResponseDto = typeof SubagentFilesResponseSchema.Type

/** Where a write lands: the global and workspace scopes beside the config file. A repository
 * file is written through the change-scoped routes (`…/subagent-files`) instead, and a built-in
 * is never saved over — the create flow's copy lands in the scope it is picked for. */
export const SubagentFileWriteSchema = Schema.Struct({
  scope: Schema.Literals(["global", "workspace"]),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
  text: Schema.String,
})
export type SubagentFileWriteDto = typeof SubagentFileWriteSchema.Type

export const SubagentFileRefSchema = Schema.Struct({
  scope: Schema.Literals(["global", "workspace"]),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
})
export type SubagentFileRefDto = typeof SubagentFileRefSchema.Type

/** A repository file's address: the repository name as the discovery key spells it
 * (`repository:orders-api:reviewer`) inside the change the route names. The scope is the route —
 * never a field to get wrong in the body. */
export const SubagentRepositoryFileWriteSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.String,
  text: Schema.String,
})
export type SubagentRepositoryFileWriteDto = typeof SubagentRepositoryFileWriteSchema.Type

export const SubagentRepositoryFileRefSchema = Schema.Struct({
  repository: Schema.String,
  id: Schema.String,
})
export type SubagentRepositoryFileRefDto = typeof SubagentRepositoryFileRefSchema.Type

/** What the Repositories view lists: one block per repository of the change's checkouts, its
 * `.corvi/subagents` files parsed exactly as the other scopes are. */
export const SubagentRepositoryFilesResponseSchema = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      files: Schema.Array(SubagentProfileFileSchema),
    }),
  ),
})
export type SubagentRepositoryFilesResponseDto = typeof SubagentRepositoryFilesResponseSchema.Type

/** What a change can run, on the wire: discovery's answer (`@corvi/agents/discovery`) as the
 * CLI reads it. The `key` is what `subagent create` takes (`repository:orders-api:reviewer`).
 * `body` is the profile file's own initial prompt (`Profile.body`); the create request's
 * `prompt` is a different thing — the orchestrator's task text that fills the `{prompt}` mark
 * in this body, or is appended to it. With no task, the mark takes the await instruction
 * (`AWAIT_INSTRUCTIONS`). A body that does not name the mark is rendered, with the task appended
 * under `## Task` when one is given; a body-less profile — or one that renders to nothing —
 * sends the task (or the instruction, with no task) alone. */
export const SubagentProfileSummarySchema = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  source: SubagentSource,
  sourceLabel: Schema.optional(Schema.String),
  label: Schema.String,
  harness: SubagentHarness,
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  body: Schema.String,
})
export type SubagentProfileSummaryDto = typeof SubagentProfileSummarySchema.Type

/** The runnable profiles and, as everywhere else, the files that did not make it — with their
 * reasons, never hidden. */
export const SubagentProfilesResponseSchema = Schema.Struct({
  profiles: Schema.Array(SubagentProfileSummarySchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reasons: Schema.Array(Schema.String) })),
})
export type SubagentProfilesResponseDto = typeof SubagentProfilesResponseSchema.Type

// --- Instances -------------------------------------------------------------------------------

/** Who a message is from. A turn's reply is always `subagent`; the other two are inbound. */
export const SubagentRole = Schema.Literals(["orchestrator", "user", "subagent"])
export type SubagentRole = typeof SubagentRole.Type

/** One entry in an instance's system log. */
export const SubagentSystemEventSchema = Schema.Struct({
  kind: Schema.Literals([
    "created",
    "opened",
    "closed",
    "turn_started",
    "turn_settled",
    "interrupted",
    "continued",
  ]),
  at: Schema.String,
  note: Schema.optional(Schema.String),
})
export type SubagentSystemEventDto = typeof SubagentSystemEventSchema.Type

/** The stored record: `session.json`. `deliveredThrough` is the durable delivery cursor `next`
 * reads; `inFlight` is the one thing not derivable after a reboot. */
export const SubagentRecordSchema = Schema.Struct({
  id: Schema.String,
  changeId: Schema.String,
  /** The resolved profile key (`global:reviewer`), not its text. */
  profile: Schema.String,
  label: Schema.String,
  harness: SubagentHarness,
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  createdBy: Schema.Literals(["orchestrator", "user"]),
  createdAt: Schema.String,
  window: Schema.optional(Schema.String),
  deliveredThrough: Schema.optional(Schema.Number),
  inFlight: Schema.optional(Schema.Number),
  /** The idempotency key a create was made with, so a retried create returns the same instance
   * rather than minting a second one. */
  createdKey: Schema.optional(Schema.String),
  log: Schema.mutable(Schema.Array(SubagentSystemEventSchema)),
})
export type SubagentRecordDto = typeof SubagentRecordSchema.Type

/** One message, as a file and on the wire. */
export const SubagentMessageSchema = Schema.Struct({
  number: Schema.Number,
  role: SubagentRole,
  at: Schema.String,
  body: Schema.String,
  pane: Schema.optional(Schema.String),
  /** The idempotency key the write was made with: a retried send/turn finds the message again
   * instead of appending a second one. */
  key: Schema.optional(Schema.String),
})
export type SubagentMessageDto = typeof SubagentMessageSchema.Type

/** One instance as the list and show routes answer: the record, the derived view, and the whole
 * conversation. */
export const SubagentInstanceSchema = Schema.Struct({
  id: Schema.String,
  changeId: Schema.String,
  profile: Schema.String,
  label: Schema.String,
  harness: SubagentHarness,
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  createdBy: Schema.Literals(["orchestrator", "user"]),
  createdAt: Schema.String,
  presence: Schema.Literals(["attached", "detached"]),
  activity: Schema.Literals(["idle", "working"]),
  interrupted: Schema.Boolean,
  awaitingReply: Schema.Boolean,
  /** The window index of the live window, for the page to focus it. */
  windowIndex: Schema.optional(Schema.Number),
  log: Schema.mutable(Schema.Array(SubagentSystemEventSchema)),
  messages: Schema.mutable(Schema.Array(SubagentMessageSchema)),
})
export type SubagentInstanceDto = typeof SubagentInstanceSchema.Type

export const SubagentListResponseSchema = Schema.Struct({
  instances: Schema.mutable(Schema.Array(SubagentInstanceSchema)),
})
export type SubagentListResponseDto = typeof SubagentListResponseSchema.Type

/** Create an instance from a profile key, optionally with the orchestrator's task text. `from`
 * records who asked (the CLI's orchestrator by default, the UI's user when the page creates it). */
export const SubagentCreateRequestSchema = Schema.Struct({
  profile: Schema.String,
  prompt: Schema.optional(Schema.String),
  from: Schema.optional(Schema.Literals(["orchestrator", "user"])),
})
export type SubagentCreateRequestDto = typeof SubagentCreateRequestSchema.Type

export const SubagentSendRequestSchema = Schema.Struct({
  text: Schema.String,
  from: Schema.optional(Schema.Literals(["orchestrator", "user"])),
})
export type SubagentSendRequestDto = typeof SubagentSendRequestSchema.Type

/** A settled turn's reply, relayed by the harness extension. */
export const SubagentTurnRequestSchema = Schema.Struct({
  text: Schema.String,
  /** The pane the reply came from, for the forensic trail when two panes claim one identity. */
  pane: Schema.optional(Schema.String),
})
export type SubagentTurnRequestDto = typeof SubagentTurnRequestSchema.Type

/** What an `await` ended as: a subagent that can be processed (`ready` — idle or waiting for
 * input with nothing pending, or a reply already parked), a lost window, an interrupted turn, or
 * the horizon's own deadline (`timeout` — check in on the subagents, then await again). `id`
 * names the subagent that settled an `--any` run. */
export const SubagentAwaitResponseSchema = Schema.Struct({
  status: Schema.Literals(["ready", "lost", "interrupted", "timeout"]),
  id: Schema.optional(Schema.String),
  /** A reply is parked for `result` to pick up. */
  awaitingReply: Schema.optional(Schema.Boolean),
})
export type SubagentAwaitResponseDto = typeof SubagentAwaitResponseSchema.Type

/** What the extension's `next` got: an inbound message to submit, an interrupted turn to leave
 * alone, or nothing yet (the poll's own deadline). */
export const SubagentNextResponseSchema = Schema.Struct({
  status: Schema.Literals(["message", "interrupted", "none"]),
  message: Schema.optional(SubagentMessageSchema),
})
export type SubagentNextResponseDto = typeof SubagentNextResponseSchema.Type
