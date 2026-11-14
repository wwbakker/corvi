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
    "patch",
    "discard",
    "diff",
    "commit",
    "push",
  ]),
  message: Schema.String,
  directory: Schema.optional(Schema.String),
  /** git's exit code, when git ran and said no; absent when it could not be run at all. */
  exitCode: Schema.optional(Schema.Number),
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

/** What `git status` lists, by path. `tracked` holds staged, modified, deleted, renamed, and
 * conflicted entries; `untracked` holds new files, a wholly untracked directory as one entry
 * ending in `/`. Ignored files are in neither. */
export type WorkingTree = {
  readonly tracked: readonly string[]
  readonly untracked: readonly string[]
}

/** What happened to one path in the working tree, as a shelf records it. */
export type PathChange = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"

/** One path that differs from HEAD — staged, unstaged or untracked, every untracked file listed
 * on its own — with its size on disk (0 when it is gone). Ignored files are never listed. */
export type ChangedPath = {
  readonly path: string
  readonly change: PathChange
  readonly bytes: number
}

/** One path as `git status` reports it, in git's own vocabulary: the XY pair (porcelain v2's `.`
 * is "nothing here"), which halves it is in, and where a rename came from. */
export type StatusEntry = {
  readonly path: string
  readonly index: string
  readonly worktree: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly from?: string
}

/** The working tree and the branch's standing against its upstream, read in one status. */
export type BranchStatus = {
  readonly entries: readonly StatusEntry[]
  /** Whether the branch has an upstream at all. */
  readonly upstream: boolean
  /** Commits ahead of the upstream; absent without one. */
  readonly ahead?: number
}

/** What applying a patch did: applied cleanly (the index left as it was before), or git's own
 * refusal. A refusal that left conflict markers is read from the status afterwards. */
export type PatchApplication =
  | { readonly _tag: "Applied" }
  | { readonly _tag: "Failed"; readonly message: string }

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
    /** How many commits HEAD has that `from` does not; 0 when `from` does not resolve. */
    readonly countCommitsSince: (repository: Repository, from: string) => Effect.Effect<number, OperationError>
    /** The base a new branch starts from: `origin/<default>` when a remote has one, else a local
     * `main` or `master`; absent when neither exists. */
    readonly defaultBranch: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
  }
  readonly status: {
    readonly workingTree: (repository: Repository) => Effect.Effect<WorkingTree, OperationError>
    /** Every changed path with both halves of git's status, and the branch's upstream standing. */
    readonly branchStatus: (repository: Repository) => Effect.Effect<BranchStatus, OperationError>
    /** Every path that differs from HEAD, one entry per file (untracked directories expanded). */
    readonly changedPaths: (repository: Repository) => Effect.Effect<readonly ChangedPath[], OperationError>
  }
  readonly diff: {
    /** One file's diff as `git diff` writes it: the index against HEAD (`staged`), the working tree
     * against the index, or an untracked file against nothing. */
    readonly file: (
      repository: Repository,
      input: { readonly path: string; readonly staged: boolean; readonly untracked: boolean },
    ) => Effect.Effect<string, OperationError>
  }
  readonly commit: {
    /** Add exactly these paths (new files and deletions included) and commit only them; anything
     * else staged stays staged. Answers the new commit's short hash. A refusal is the error, with
     * git's own words. */
    readonly paths: (
      repository: Repository,
      input: { readonly message: string; readonly paths: readonly string[] },
    ) => Effect.Effect<string | undefined, OperationError>
  }
  readonly patch: {
    /** Write every difference between HEAD and the working tree — staged and unstaged changes to
     * tracked files, and the named untracked files as new files — as one binary-safe patch at
     * `file`, and answer its size in bytes. Neither the index nor the working tree is touched. */
    readonly write: (
      repository: Repository,
      input: { readonly file: AbsolutePath; readonly untracked: readonly string[] },
    ) => Effect.Effect<number, OperationError>
    /** Whether the patch applies to the working tree; `reverse` asks whether the working tree
     * holds exactly what the patch adds. Changes nothing. */
    readonly applies: (
      repository: Repository,
      input: { readonly file: AbsolutePath; readonly reverse: boolean },
    ) => Effect.Effect<boolean, OperationError>
    /** Apply the patch with a three-way fallback (`git apply --3way`). A clean application is
     * unstaged again, so the files come back as working-tree changes; a conflicted one leaves the
     * index holding the conflict. */
    readonly apply: (
      repository: Repository,
      input: { readonly file: AbsolutePath },
    ) => Effect.Effect<PatchApplication, OperationError>
  }
  readonly integration: {
    /** Conservative proof that `branch`'s content is in `base`: ancestry, then patch
     * equivalence, then a simulated merge that changes nothing (what a squash merge of several
     * commits leaves). Anything else is false; a failed lookup is not a proof. */
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
    /** `git push -u <remote> <branch>`: sends the branch and sets its upstream. Answers what git said
     * it did (the last line); a refusal is the error, with git's own words. */
    readonly push: (
      repository: Repository,
      input: { readonly remote: string; readonly branch: string },
    ) => Effect.Effect<string, OperationError>
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
    /** Put the tracked files back to HEAD (`git reset --hard`) and delete exactly the named
     * untracked files. Ignored files and untracked files not named are left alone. */
    readonly discardChanges: (
      repository: Repository,
      input: { readonly untracked: readonly string[] },
    ) => Effect.Effect<void, OperationError>
  }
}

export class Service extends Context.Service<Service, Interface>()("corvi/GitService") {}
