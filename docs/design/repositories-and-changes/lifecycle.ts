/** Design prototype: completion and cancellation over the capabilities.
 *
 * These are the only writers of terminal phases. They compose `changes` (records and links),
 * `repositories` (removal safety), `OperationProgress` (the journal), and provider ports for the
 * external steps. An earlier assessment is never authorization: the destructive steps recheck
 * the facts they act on.
 */
import { Context, Data, type Effect } from "effect"

import type { Change, ChangeId, RepositoryRef } from "@corvi/contracts/changes"
import type {
  ChangeConflict,
  ChangeNotFound,
  ChangeStoreError,
  InvalidTransition,
  RepositoryStoreError,
} from "./model.ts"
import type { CheckoutError } from "./repositories.ts"

/** What an acknowledgement is for. A hard reason has no code: it cannot be acknowledged away. */
export type AcknowledgementCode =
  | "review-pending"
  | "unpushed"
  | "ownership-unverified"
  | "shared-worktree"
  | "provider-veto"

export type LifecycleReasonCode = AcknowledgementCode | "idea" | "dirty-worktree"

export type LifecycleReason = {
  readonly code: LifecycleReasonCode
  /** The repository the reason is about, when it is about one. */
  readonly subject?: RepositoryRef
  /** Hard reasons refuse; forceable reasons are acknowledged one by one. */
  readonly kind: "forceable" | "hard"
  readonly text: string
  /** Fingerprints the facts this reason was observed from: changed facts need a new
   * acknowledgement, so a stale "yes" cannot authorize a deletion against a changed state. */
  readonly facts: string
}

export type Readiness =
  | { readonly _tag: "Ready"; readonly toMerge: readonly OutstandingPullRequest[] }
  | {
      readonly _tag: "AcknowledgementRequired"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }
  | {
      readonly _tag: "Blocked"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }

/** One acknowledged reason. The facts must still match when the destructive step runs. */
export type Acknowledgement = {
  readonly code: AcknowledgementCode
  readonly subject?: RepositoryRef
  readonly facts: string
}

export type LifecycleOutcome =
  | {
      readonly _tag: "Done"
      readonly change: Change
      /** Observer and post-commit warnings; never make the operation fail. */
      readonly notes: readonly string[]
      /** What cancelling deliberately left alone; empty for completion. */
      readonly loose: readonly string[]
    }
  | {
      readonly _tag: "NeedsAcknowledgement"
      readonly operation: "complete" | "cancel"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }
  | {
      readonly _tag: "Blocked"
      readonly operation: "complete" | "cancel"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }

export class ChangeOperationInProgress extends Data.TaggedError("ChangeOperationInProgress")<{
  readonly changeId: ChangeId
}> {}

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class TerminalError extends Data.TaggedError("TerminalError")<{
  readonly changeId: ChangeId
  readonly message: string
  readonly cause?: unknown
}> {}

/** The provider ports a lifecycle operation needs. Composed by the server; never imported by
 * `changes` or `repositories`. */
export type PullRequestState = {
  readonly repository: RepositoryRef
  readonly number: number
  readonly ready: boolean
  readonly merged: boolean
  readonly reason?: string
}

export interface PullRequestsInterface {
  /** Fresh facts at the click, not a dashboard poll. */
  readonly readiness: (input: {
    readonly change: Change
    readonly repository: RepositoryRef
    /** The click path forgets cached reads and fetches before deciding; the poll does not. */
    readonly fresh: boolean
  }) => Effect.Effect<PullRequestState, ProviderError>
  readonly merge: (input: {
    readonly change: Change
    readonly repository: RepositoryRef
    readonly number: number
  }) => Effect.Effect<string | undefined, ProviderError>
  /** Open pull requests, for a cancellation's loose ends. */
  readonly outstanding: (change: Change) => Effect.Effect<readonly OutstandingPullRequest[], ProviderError>
}

export type OutstandingPullRequest = {
  readonly repository: RepositoryRef
  readonly number: number
}

export class PullRequests extends Context.Tag("corvi/workflows/PullRequests")<PullRequests, PullRequestsInterface>() {}

export interface IssuesInterface {
  /** The ticket step a completed change needs; a note may explain what it did. */
  readonly transition: (change: Change) => Effect.Effect<string | undefined, ProviderError>
  /** Where the issue stands, for a cancellation's loose ends: one line each. */
  readonly current: (change: Change) => Effect.Effect<readonly string[], ProviderError>
}

export class Issues extends Context.Tag("corvi/workflows/Issues")<Issues, IssuesInterface>() {}

export interface TerminalSessionsInterface {
  /** Stops the session this change owns; never one chosen by name, port, or resemblance. */
  readonly stop: (changeId: ChangeId) => Effect.Effect<void, TerminalError>
}

export class TerminalSessions extends Context.Tag("corvi/workflows/TerminalSessions")<
  TerminalSessions,
  TerminalSessionsInterface
>() {}

export interface Interface {
  readonly assessCompletion: (
    changeId: ChangeId,
  ) => Effect.Effect<
    Readiness,
    ChangeNotFound | ChangeStoreError | RepositoryStoreError | ProviderError | CheckoutError
  >
  readonly completeChange: (input: {
    readonly changeId: ChangeId
    readonly acknowledgements?: readonly Acknowledgement[]
  }) => Effect.Effect<
    LifecycleOutcome,
    | ChangeNotFound
    | InvalidTransition
    | ChangeConflict
    | ChangeOperationInProgress
    | ChangeStoreError
    | RepositoryStoreError
    | ProviderError
    | TerminalError
    | CheckoutError
  >
  readonly assessCancellation: (
    changeId: ChangeId,
  ) => Effect.Effect<Readiness, ChangeNotFound | ChangeStoreError | RepositoryStoreError | CheckoutError>
  readonly cancelChange: (input: {
    readonly changeId: ChangeId
    readonly acknowledgements?: readonly Acknowledgement[]
  }) => Effect.Effect<
    LifecycleOutcome,
    | ChangeNotFound
    | InvalidTransition
    | ChangeConflict
    | ChangeOperationInProgress
    | ChangeStoreError
    | RepositoryStoreError
    | ProviderError
    | TerminalError
    | CheckoutError
  >
}

export class ChangeLifecycle extends Context.Tag("corvi/workflows/ChangeLifecycle")<ChangeLifecycle, Interface>() {}
