/** The Git adapter surface the repositories capability needs.
 *
 * Ported from `opencode/packages/core/src/git.ts` (Effect 4 beta) to Effect 3, and narrowed to
 * the operations this slice calls. `discover` keeps an error channel so a failed read is not
 * mistaken for absence. This entrypoint exposes only the port; the real adapter is `./node`.
 */
import { Context, Data, Schema, type Effect } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: AbsolutePath,
  kind: Schema.Literal("main", "linked"),
}) {}

/** The branch's tracking state. `Unavailable` is a configured upstream whose comparison could
 * not be read; it must not be treated as zero ahead/behind. */
export type UpstreamState =
  | { readonly _tag: "NoUpstream" }
  | { readonly _tag: "Counted"; readonly ahead: number; readonly behind: number }
  | { readonly _tag: "Unavailable" }

export class OperationError extends Data.TaggedError("Git.OperationError")<{
  readonly operation:
    | "discover"
    | "checkout"
    | "create"
    | "remove"
    | "list"
    | "status"
    | "upstream"
    | "integration"
  readonly message: string
  readonly directory?: string
  readonly cause?: unknown
}> {}

export interface Interface {
  readonly repo: {
    readonly discover: (directory: AbsolutePath) => Effect.Effect<Repository | undefined, OperationError>
    /** Whether the repository has any remote (or the named one). */
    readonly hasRemote: (repository: Repository, remote?: string) => Effect.Effect<boolean, OperationError>
  }
  readonly history: {
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
    readonly head: (repository: Repository) => Effect.Effect<string | undefined, OperationError>
    readonly branchExists: (repository: Repository, branch: string) => Effect.Effect<boolean, OperationError>
    readonly upstream: (repository: Repository) => Effect.Effect<UpstreamState, OperationError>
    /** The remote's symbolic HEAD, from local metadata only; never fetches. */
    readonly defaultRemoteBranch: (
      repository: Repository,
      remote?: string,
    ) => Effect.Effect<string | undefined, OperationError>
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
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { readonly remote?: string; readonly branch: string; readonly reset?: boolean },
    ) => Effect.Effect<void, OperationError>
    /** Deletes a local branch even when its commits look unmerged; the caller has proven the
     * content landed. */
    readonly deleteBranch: (repository: Repository, branch: string) => Effect.Effect<void, OperationError>
    readonly fetchRemote: (repository: Repository, remote?: string) => Effect.Effect<void, OperationError>
    /** `git switch <branch>`, or `git switch --create <branch> --no-track <base>` when creating;
     * a creation without a base branches from HEAD. */
    readonly switchToBranch: (
      repository: Repository,
      input: { readonly branch: string; readonly create?: boolean; readonly base?: string },
    ) => Effect.Effect<void, OperationError>
  }
  readonly worktree: {
    readonly create: (input: {
      readonly repository: Repository
      readonly directory: AbsolutePath
    }) => Effect.Effect<Repository, OperationError>
    readonly remove: (input: {
      readonly repository: Repository
      readonly directory: AbsolutePath
      readonly force: boolean
    }) => Effect.Effect<void, OperationError>
    readonly list: (repository: Repository) => Effect.Effect<readonly Worktree[], OperationError>
    /** Adds a linked worktree: for an existing branch, or creating the branch from `base`
     * (branches from HEAD when no base is given, and never setting up an upstream). */
    readonly add: (input: {
      readonly repository: Repository
      readonly directory: AbsolutePath
      readonly branch: string
      readonly base?: string
      readonly create: boolean
    }) => Effect.Effect<Repository, OperationError>
  }
}

export class Service extends Context.Tag("corvi/GitService")<Service, Interface>() {}
