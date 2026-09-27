/** The subagent profile vocabulary on the wire: what the Subagents page lists and edits.
 *
 * A profile is a template for a subagent instance — harness, model, effort and an initial
 * prompt. Like an action, it is one Markdown file with YAML frontmatter; the page edits the file
 * itself, so what it sends is the file's text. The profile's own parsed shape is
 * `@corvi/agents/profile`'s; this file is what the browser and the server share. */
import { Schema } from "effect"

/** The harness a profile starts. */
export const SubagentHarness = Schema.Literal("pi", "opencode")
export type SubagentHarness = typeof SubagentHarness.Type

/** Where the profile's file was discovered. Built-in files are shipped with Corvi; repository
 * files are the checkout's own and are not managed by the page. */
export const SubagentSource = Schema.Literal("builtin", "global", "workspace", "repository")
export type SubagentSource = typeof SubagentSource.Type

/** One profile file as the page lists it: the file as written, and what it parses to — or why it
 * does not, shown so it can be fixed right there. */
export const SubagentProfileFileSchema = Schema.Struct({
  scope: SubagentSource,
  /** The workspace a workspace file belongs to. */
  workspace: Schema.optional(Schema.String),
  workspaceLabel: Schema.optional(Schema.String),
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

/** The scopes the page may write. Saving a built-in copies it to Global; repository files are
 * written with your IDE or by an agent, never here. */
export const SubagentFileWriteSchema = Schema.Struct({
  scope: Schema.Literal("global", "workspace"),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
  text: Schema.String,
})
export type SubagentFileWriteDto = typeof SubagentFileWriteSchema.Type

export const SubagentFileRefSchema = Schema.Struct({
  scope: Schema.Literal("global", "workspace"),
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
})
export type SubagentFileRefDto = typeof SubagentFileRefSchema.Type

// --- Instances -------------------------------------------------------------------------------

/** Who a message is from. A turn's reply is always `subagent`; the other two are inbound. */
export const SubagentRole = Schema.Literal("orchestrator", "user", "subagent")
export type SubagentRole = typeof SubagentRole.Type

/** One entry in an instance's system log. */
export const SubagentSystemEventSchema = Schema.Struct({
  kind: Schema.Literal(
    "created",
    "opened",
    "closed",
    "turn_started",
    "turn_settled",
    "interrupted",
    "continued",
  ),
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
  createdBy: Schema.Literal("orchestrator", "user"),
  createdAt: Schema.String,
  window: Schema.optional(Schema.String),
  deliveredThrough: Schema.optional(Schema.Number),
  inFlight: Schema.optional(Schema.Number),
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
  createdBy: Schema.Literal("orchestrator", "user"),
  createdAt: Schema.String,
  presence: Schema.Literal("attached", "detached"),
  activity: Schema.Literal("idle", "working"),
  interrupted: Schema.Boolean,
  awaitingReply: Schema.Boolean,
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
  from: Schema.optional(Schema.Literal("orchestrator", "user")),
})
export type SubagentCreateRequestDto = typeof SubagentCreateRequestSchema.Type

export const SubagentSendRequestSchema = Schema.Struct({
  text: Schema.String,
  from: Schema.optional(Schema.Literal("orchestrator", "user")),
})
export type SubagentSendRequestDto = typeof SubagentSendRequestSchema.Type

/** A settled turn's reply, relayed by the harness extension. */
export const SubagentTurnRequestSchema = Schema.Struct({ text: Schema.String })
export type SubagentTurnRequestDto = typeof SubagentTurnRequestSchema.Type

/** What a `wait` ended as: a delivered turn, a lost window, an interrupted turn, or the long
 * poll's own deadline. `id` names the subagent for `--any`/`--all` runs. */
export const SubagentWaitResponseSchema = Schema.Struct({
  status: Schema.Literal("turn", "lost", "interrupted", "timeout"),
  id: Schema.optional(Schema.String),
  message: Schema.optional(SubagentMessageSchema),
})
export type SubagentWaitResponseDto = typeof SubagentWaitResponseSchema.Type

/** What the extension's `next` got: an inbound message to submit, an interrupted turn to leave
 * alone, or nothing yet (the poll's own deadline). */
export const SubagentNextResponseSchema = Schema.Struct({
  status: Schema.Literal("message", "interrupted", "none"),
  message: Schema.optional(SubagentMessageSchema),
})
export type SubagentNextResponseDto = typeof SubagentNextResponseSchema.Type
