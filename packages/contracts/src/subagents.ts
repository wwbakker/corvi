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
