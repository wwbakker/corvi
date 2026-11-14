/** Agent transcripts kept with a change: the sessions an agent ran in the change, copied into
 * `transcripts/` when the change is archived, and their rendering vocabulary. */
import { Schema } from "effect"

export const TranscriptHarness = Schema.Literals(["pi", "opencode"])
export type TranscriptHarness = typeof TranscriptHarness.Type

export const TranscriptSummarySchema = Schema.Struct({
  /** Where the copy is, relative to the change's `transcripts/` directory. */
  id: Schema.String,
  harness: TranscriptHarness,
  sessionId: Schema.String,
  /** The directory the agent ran in, as it was then. */
  cwd: Schema.String,
  /** That directory relative to the change's: empty for the change's own terminal. */
  where: Schema.String,
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  /** How many entries the conversation has. */
  entries: Schema.Number,
})
export type TranscriptSummaryDto = typeof TranscriptSummarySchema.Type

/** One step of a conversation, harness-neutral. Long tool output is shortened for reading; the
 * copied file stays whole. */
export const TranscriptEntrySchema = Schema.Union([
  Schema.TaggedStruct("Message", {
    role: Schema.Literals(["user", "assistant", "system"]),
    text: Schema.String,
    at: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Thinking", { text: Schema.String, at: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("ToolCall", {
    name: Schema.String,
    input: Schema.String,
    at: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("ToolResult", {
    name: Schema.String,
    output: Schema.String,
    error: Schema.Boolean,
    at: Schema.optional(Schema.String),
  }),
  /** Everything else worth a line: a model switch, a compaction summary, a shell command. */
  Schema.TaggedStruct("Note", { text: Schema.String, at: Schema.optional(Schema.String) }),
])
export type TranscriptEntryDto = typeof TranscriptEntrySchema.Type

export const TranscriptSchema = Schema.Struct({
  summary: TranscriptSummarySchema,
  entries: Schema.Array(TranscriptEntrySchema),
})
export type TranscriptDto = typeof TranscriptSchema.Type

export const TranscriptListSchema = Schema.Array(TranscriptSummarySchema)
