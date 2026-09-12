import { Schema } from "effect";
import { CHANGE_STATES, type Change as ChangeShape } from "../../domain/change.ts";

/**
 * The change.json on disk — the JSON boundary of a change (src/change/server/store.ts).
 *
 * Decode keeps unknown keys (`onExcessProperty: "preserve"` at the decode site): a change.json
 * carries whatever the code that wrote it put there, and rewriting it must not drop fields a
 * newer or older IWE version added.
 */
export const Change = Schema.Struct({
  /** Directory name under the changes root; also the default branch name. */
  id: Schema.String,
  /** Branch used in every repo worktree of this change. */
  branch: Schema.String,
  /** Absolute paths to the source repositories this change touches. */
  repos: Schema.mutable(Schema.Array(Schema.String)),
  /** Branch each repository's work started from, keyed by repository path. */
  base: Schema.optional(Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.String }))),
  /** The subset of `repos` worked on in place. */
  direct: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** Which workspace the change belongs to. */
  workspace: Schema.optional(Schema.String),
  /** Extensions' own data about this change, keyed by extension name. Kept verbatim: the shape
   * is the owning extension's business, and rewriting a change.json must not drop it. */
  extensions: Schema.optional(
    Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  ),
  title: Schema.optional(Schema.String),
  titleEdited: Schema.optional(Schema.Boolean),
  state: Schema.optional(Schema.Union(...CHANGE_STATES.map((s) => Schema.Literal(s)))),
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
});

// The schema and the hand-written type must not drift: this line fails to compile if the
// schema stops describing exactly the Change every module reads.
const _changeMatchesType: Schema.Schema<ChangeShape> = Change;
