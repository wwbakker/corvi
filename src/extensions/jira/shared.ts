/**
 * The jira extension's vocabulary, shared between its two halves: the server reads and writes
 * these, the browser renders them. The schemas are the one statement of the wire shapes; the
 * types derive from them, so neither half can drift from what the other serves.
 */
import { Schema } from "effect";

/** An issue as Corvi reads it, flattened from Jira's own shape. */
export const IssueSchema = Schema.Struct({
  key: Schema.String,
  summary: Schema.String,
  assignee: Schema.String,
  status: Schema.String,
  type: Schema.String,
  /** Sprint name, or "" for issues in no sprint (backlog). */
  sprint: Schema.String,
});
export type Issue = typeof IssueSchema.Type;

export const SprintSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
});
export type Sprint = typeof SprintSchema.Type;

/** What the wizard's issue table is served: the board, or why there is no board — an error
 * string rather than a failure, because a broken or unconfigured Jira must still leave you able
 * to type a change id by hand. */
export const BoardSchema = Schema.Struct({
  issues: Schema.mutable(Schema.Array(IssueSchema)),
  sprints: Schema.mutable(Schema.Array(Schema.String)),
  baseUrl: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type Board = typeof BoardSchema.Type;

/** What the jira extension writes into a change's `extensions` bag when its wizard step picked
 * an issue. */
export const TicketRefSchema = Schema.Struct({ key: Schema.String });
export type TicketRef = typeof TicketRefSchema.Type;
