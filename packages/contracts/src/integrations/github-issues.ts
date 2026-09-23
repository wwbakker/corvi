import { Schema } from "effect";
import type { ChangeWireDto } from "../api.ts";

/**
 * The github-issues extension's vocabulary, shared between its two halves. The schemas are the
 * one statement of the wire shapes; the types are derived from them, and both halves use those.
 */

/** An issue as Corvi reads it, flattened from what `gh` answers. */
export const GitHubIssueSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  /** GitHub's own: "open" or "closed". */
  state: Schema.String,
  url: Schema.optional(Schema.String),
  assignees: Schema.mutable(Schema.Array(Schema.String)),
  labels: Schema.mutable(Schema.Array(Schema.String)),
});
export type GitHubIssue = typeof GitHubIssueSchema.Type;

/** What the extension writes into a change's `extensions` bag: which repository, which issue.
 * The repository is the source path, so a renamed GitHub repository still resolves. It is also
 * the link route's body: one shape for the bag entry and the wire. */
export const IssueRefSchema = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
});
export type IssueRef = typeof IssueRefSchema.Type;

/** The bag key, which is also the extension's name. */
export const KEY = "github-issues";

/** The change's issue, from wherever this extension put it. */
export const refOf = (change: ChangeWireDto): IssueRef | undefined =>
  change.extensions?.[KEY] as IssueRef | undefined;

/** How the issue is spoken about: `owner/name#123`. */
export const refLabel = (nameWithOwner: string, ref: IssueRef): string =>
  `${nameWithOwner}#${ref.number}`;
