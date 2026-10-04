/** The Git adapter surface the repositories capability needs.
 *
 * Adapted from `opencode/packages/core/src/git.ts` (Effect 4), and narrowed to the operations
 * this slice calls. `discover` keeps an error channel so a failed read is not mistaken for
 * absence. This entrypoint exposes only the port; the real adapter is `./node`.
 */
import { Context, Schema, type Effect } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

/** The branch's tracking state. `Unavailable` is a configured upstream whose comparison could
 * not be read; it must not be treated as zero ahead/behind. */
export type UpstreamState =
  | { readonly _tag: "NoUpstream" }
  | { readonly _tag: "Counted"; readonly ahead: number; readonly behind: number }
  | { readonly _tag: "Unavailable" }

export class OperationError extends Schema.TaggedError<OperationError>()("Git.OperationError", {
  operation: Schema.Literals([
    "discover",
    "checkout",
    "create",
    "remove",
    "status",
    "upstream",
    "integration",
    "merge",
    "pull",
  ]),
  message: Schema.String,
  directory: Schema.optional(Schema.String),
  // The cause is an opaque in-process throwable that is never serialized; `Schema.Unknown`
  // preserves it exactly (on decode `Schema.Defect()` is lossy).
  cause: Schema.optional(Schema.Unknown),
}) {}

/** A selected branch's attachment and freshness names, resolved from local Git metadata. */
export type ExistingBranch = {
  readonly branch: string
  readonly remoteRef?: string
  readonly remote?: string
}

/** One commit an upstream has that the checkout does not, as a list reads it. */
export type IncomingCommit = {
  readonly sha: string
  readonly subject: string
}

export interface Interface {
  readonly repo: {
    readonly discover: (directory: AbsolutePath) => Effect.Effect<Repository | undefined, OperationError>
    /** Whether the repository has any remote (or the named one). */
    readonly hasRemote: (repository: Repository, remote?: string) => Effect.Effect<boolean, OperationError>
    /** The remote's fetch URL, for building links back to it. Absent when the remote is not
     * configured; never a failure. */
    readonly remoteUrl: (
      repository: Repository,
      remote?: string,
    ) => Effect.Effect<string | undefined, OperationError>
  }
  readonly history: {
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
    readonly head: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
    readonly branchExists: (repository: Repository, branch: string) => Effect.Effect<boolean, OperationError>
    /** Resolve a local or remote branch selection without creating or switching anything. */
    readonly resolveExistingBranch: (
      repository: Repository,
      name: string,
    ) => Effect.Effect<ExistingBranch, OperationError>
    /** Whether a ref resolves to a commit — a remote counterpart like `origin/feature`, for
     * instance. An unresolvable ref is false, not a failure. */
    readonly refExists: (repository: Repository, ref: string) => Effect.Effect<boolean, OperationError>
    /** Whether `ancestor` is an ancestor of `descendant` (`git merge-base --is-ancestor`). An
     * unresolvable ref is false: an unknown revision proves nothing. */
    readonly isAncestor: (
      repository: Repository,
      input: { readonly ancestor: string; readonly descendant: string },
    ) => Effect.Effect<boolean, OperationError>
    readonly upstream: (repository: Repository) => Effect.Effect<UpstreamState, OperationError>
    /** The remote's symbolic HEAD, from local metadata only; never fetches. */
    readonly defaultRemoteBranch: (
      repository: Repository,
      remote?: string,
    ) => Effect.Effect<string | undefined, OperationError>
    /** The upstream tip's sha, when the branch has an upstream whose ref exists. */
    readonly upstreamTip: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
    /** The commits the upstream has and HEAD does not, newest first. Empty without an upstream. */
    readonly upstreamCommits: (
      repository: Repository,
    ) => Effect.Effect<readonly IncomingCommit[], OperationError>
    /** The base a new branch starts from: `origin/<default>` when a remote has one, else a local
     * `main` or `master`; absent when neither exists. */
    readonly defaultBranch: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
  }
  readonly status: {
    /** Whether the working tree holds staged, modified, untracked, or conflicted entries. */
    readonly dirty: (repository: Repository) => Effect.Effect<boolean, OperationError>
  }
  readonly integration: {
    /** Conservative proof that `branch`'s content is in `base`: ancestry, then patch
     * equivalence. Anything else is false; a failed lookup is not a proof. */
    readonly proven: (
      repository: Repository,
      input: { readonly branch: string; readonly base: string },
    ) => Effect.Effect<boolean, OperationError>
  }
  readonly sync: {
    /** Deletes a local branch even when its commits look unmerged; the caller has proven the
     * content landed. */
    readonly deleteBranch: (repository: Repository, branch: string) => Effect.Effect<void, OperationError>
    readonly fetchRemote: (repository: Repository, remote?: string) => Effect.Effect<void, OperationError>
    /** `git pull --ff-only`: moves to the upstream's tip exactly when that is a fast-forward, and
     * fails rather than merging or rebasing anything else. */
    readonly pullFastForward: (repository: Repository) => Effect.Effect<void, OperationError>
    /** `git merge --ff-only <to>`: moves HEAD to `to` exactly when that is a fast-forward. A
     * refusal (own commits, diverged history, uncommitted work a merge would clobber, a `to`
     * that is not something to merge) is the error's message — git's own answer is what the
     * caller reports. */
    readonly mergeFastForwardOnly: (
      repository: Repository,
      input: { readonly to: string },
    ) => Effect.Effect<void, OperationError>
    /** `git switch <branch>`, or `git switch --create <branch> --no-track <base>` when creating;
     * a creation without a base branches from HEAD. `track` explicitly creates a local branch
     * tracking that remote ref instead of using `base`. */
    readonly switchToBranch: (
      repository: Repository,
      input: { readonly branch: string; readonly create?: boolean; readonly base?: string; readonly track?: string },
    ) => Effect.Effect<void, OperationError>
  }
  readonly worktree: {
    readonly remove: (input: {
      readonly repository: Repository
      readonly directory: AbsolutePath
      readonly force: boolean
    }) => Effect.Effect<void, OperationError>
    /** Adds a linked worktree: for an existing local branch, creating one from `base`
     * (branches from HEAD when no base is given, without an upstream), or explicitly creating a
     * tracking branch from `track`. Never pass a remote ref as the attachment branch. */
    readonly add: (input: {
      readonly repository: Repository
      readonly directory: AbsolutePath
      readonly branch: string
      readonly base?: string
      readonly create: boolean
      /** Create a local tracking branch from this remote ref, not from `base`. */
      readonly track?: string
    }) => Effect.Effect<Repository, OperationError>
  }
}

export class Service extends Context.Service<Service, Interface>()("corvi/GitService") {}
