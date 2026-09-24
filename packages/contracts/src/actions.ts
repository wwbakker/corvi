/** The action menu's wire vocabulary: what the page lists and what a run carries back.
 *
 * The client names an action by key and never sends or receives its text — a prompt is pasted
 * and a command is run where the file said, and the words stay on the machine. */
import { Schema } from "effect";

/** What an action delivers: text for an agent, or a shell command. */
export const ActionKind = Schema.Literal("prompt", "command");
export type ActionKind = typeof ActionKind.Type;

/** Where it goes: the pane you are on, the window an agent runs in, or a new window. */
export const ActionTarget = Schema.Literal("active", "agent", "new");
export type ActionTarget = typeof ActionTarget.Type;

/** Where the action's file was discovered. */
export const ActionSource = Schema.Literal("builtin", "global", "workspace", "repository");
export type ActionSource = typeof ActionSource.Type;

/** One action as the menu lists it. The key names the file's place, not its text: running one
 * is naming the key, and the server resolves the file again. */
export const ActionSummarySchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kind: ActionKind,
  target: ActionTarget,
  source: ActionSource,
  /** The workspace or repository an action came from ("orders-api"), for its source line. */
  sourceLabel: Schema.optional(Schema.String),
});
export type ActionSummaryDto = typeof ActionSummarySchema.Type;

export const RunActionRequestSchema = Schema.Struct({
  key: Schema.String,
  /** The window the menu was opened on (tmux's `@3`): `target: active` means this one. */
  window: Schema.optional(Schema.String),
});
export type RunActionRequestDto = typeof RunActionRequestSchema.Type;

/** What a run did, as facts — the page composes its own notice from them. */
export const RunActionResultSchema = Schema.Struct({
  kind: ActionKind,
  /** Whether Enter followed: a submitted prompt, or a command. False leaves a prompt waiting in
   * the agent's editor for you to read. */
  submitted: Schema.Boolean,
  /** A window was started for this run (`target: new`, or `agent` with none running). */
  started: Schema.Boolean,
  /** The window it landed in, freshly started ones included. */
  window: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      label: Schema.optional(Schema.String),
    }),
  ),
});
export type RunActionResultDto = typeof RunActionResultSchema.Type;

/** Where a file the page may edit lives. Built-in files are read-only — saving one copies it to
 * Global — and repository files are the checkout's own, written with your IDE or by an agent,
 * never by this page. */
export const ActionFileScope = Schema.Literal("global", "workspace");
export type ActionFileScope = typeof ActionFileScope.Type;

/** One action file as the page lists it: the file as written, and what it parses to — or why it
 * does not, shown so it can be fixed right there. */
export const ActionFileSchema = Schema.Struct({
  scope: ActionSource,
  /** The workspace a workspace file belongs to. */
  workspace: Schema.optional(Schema.String),
  workspaceLabel: Schema.optional(Schema.String),
  /** The filename without `.md`: the action's id. */
  id: Schema.String,
  path: Schema.String,
  /** Frontmatter and body together, exactly as the file is on disk. */
  text: Schema.String,
  label: Schema.optional(Schema.String),
  problems: Schema.optional(Schema.Array(Schema.String)),
});
export type ActionFileDto = typeof ActionFileSchema.Type;

export const ActionFilesResponseSchema = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  files: Schema.Array(ActionFileSchema),
});
export type ActionFilesResponseDto = typeof ActionFilesResponseSchema.Type;

export const ActionFileWriteSchema = Schema.Struct({
  scope: ActionFileScope,
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
  text: Schema.String,
});
export type ActionFileWriteDto = typeof ActionFileWriteSchema.Type;

export const ActionFileRefSchema = Schema.Struct({
  scope: ActionFileScope,
  workspace: Schema.optional(Schema.String),
  id: Schema.String,
});
export type ActionFileRefDto = typeof ActionFileRefSchema.Type;
