/**
 * Browser-safe request and response types for local repository review. The schemas are the one
 * statement of the wire shapes; the types derive from them, and both halves use those.
 */
import { Schema } from "effect";

/** One file git has something to say about, in the vocabulary git itself uses. */
export const FileChangeSchema = Schema.Struct({
  path: Schema.String,
  /** Status of the index against HEAD, and of the working tree against the index: git's own XY
   * pair, e.g. `M`, `A`, `D`, `R`. A dot means "nothing here" in porcelain v2. */
  index: Schema.String,
  worktree: Schema.String,
  /** Where it will be listed. A file can be both: staged edits with more edits on top. */
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  untracked: Schema.Boolean,
  /** Where a renamed file came from, since the new name alone loses the point. */
  from: Schema.optional(Schema.String),
});
export type FileChange = typeof FileChangeSchema.Type;

/** What the review tab knows about one repository: what is uncommitted, and what is committed
 * but not pushed. */
export const LocalStatusSchema = Schema.Struct({
  repo: Schema.String,
  name: Schema.String,
  worktree: Schema.optional(Schema.String),
  files: Schema.mutable(Schema.Array(FileChangeSchema)),
  /** Commits the remote has not got: ahead of the upstream, or everything since the base branch
   * when the branch was never pushed. */
  unpushed: Schema.Number,
  /** Whether the branch has an upstream at all, which decides how it is pushed. */
  tracked: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type LocalStatus = typeof LocalStatusSchema.Type;

/** Which file is being looked at: the repository as well, since two repositories may both have
 * a README.md, and the staged half, since that is a different diff of the same path. */
export type Selection = { repo: string; file: string; staged: boolean };

/** One commit per repository, with the same message: a change is one piece of work, and its
 * repositories are an implementation detail of where the code lives. */
export type CommitRequest = { message: string; files: Record<string, string[]> };

export const CommitResultSchema = Schema.Struct({
  repo: Schema.String,
  name: Schema.String,
  ok: Schema.Boolean,
  /** Short hash of what was committed, or what git said about the push: the confirmation. */
  hash: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type CommitResult = typeof CommitResultSchema.Type;
