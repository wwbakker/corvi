/**
 * Browser-safe request and response types for leftover directories.
 */
import { Schema } from "effect";

/**
 * A directory in the changes root that no longer belongs to a change: what a completed change
 * left behind (build output, a shell's history) after `change.json` moved to the archive, or a
 * change that was never finished being created.
 *
 * They are harmless and easy to miss, which is why they are worth showing rather than deleting
 * on your behalf: only you know whether that `target/` is worth keeping. The schema is the one
 * statement of the shape, decoded by the page and filled by the server.
 */
export const LeftoverSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  /** Top-level entries, so you can see what is in there before removing it. A `git` entry is one
   * you should think twice about: a worktree still registered with its repository, or a whole
   * clone with a history of its own. */
  entries: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        directory: Schema.Boolean,
        git: Schema.optional(Schema.Literal("worktree", "repository")),
      }),
    ),
  ),
  /** Total size in kilobytes, as `du` reports it. */
  kilobytes: Schema.Number,
});
export type Leftover = typeof LeftoverSchema.Type;
