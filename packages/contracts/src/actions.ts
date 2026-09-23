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
