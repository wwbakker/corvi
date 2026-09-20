/** Design prototype: the Git adapter surface the repositories capability needs.
 *
 * Ported from `opencode/packages/core/src/git.ts` (Effect 4 beta) to Effect 3, and narrowed to
 * the operations this slice calls. `discover` keeps an error channel so a failed read is not
 * mistaken for absence.
 */
import { Context, Data, Schema, type Effect } from "effect"

import type { AbsolutePath } from "./paths.ts"

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: Schema.String,
  gitDirectory: Schema.String,
  commonDirectory: Schema.String,
}) {}

export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: Schema.String,
  kind: Schema.Literal("main", "linked"),
}) {}

export class OperationError extends Data.TaggedError("Git.OperationError")<{
  readonly operation: "discover" | "checkout" | "create" | "remove" | "list"
  readonly message: string
  readonly directory?: string
  readonly cause?: unknown
}> {}

export interface Interface {
  readonly repo: {
    readonly discover: (directory: AbsolutePath) => Effect.Effect<Repository | undefined, OperationError>
  }
  readonly history: {
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined>
    readonly head: (repository: Repository) => Effect.Effect<string | undefined>
  }
  readonly sync: {
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { readonly remote?: string; readonly branch: string; readonly reset?: boolean },
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
  }
}

export class Service extends Context.Tag("corvi/GitService")<Service, Interface>() {}
