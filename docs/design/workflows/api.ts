/** Design prototype: application policy and read/lifecycle workflow contracts. */
import { Context, Data } from "effect";
import type { Brand, Effect, Layer, Option } from "effect";
import type {
  AbsolutePath, BranchName, CommitId, History, InspectionError, IntegrationAssessment,
  References, ReferenceError, RemoteName, RepositoryRef, WorktreeIdentityError,
  WorktreeRef, WorktreeSnapshot, Worktrees,
} from "../repositories/api.ts";
import type {
  AssociationState, ChangeId, ChangeNotFound, ChangeState, ChangeStore, ChangeStoreError,
  RepositoryIntent, RepositoryNotInChange, WorkspaceId, WorktreeAssociation,
} from "../changes/api.ts";

export interface DefaultBasePolicy {
  readonly preferredRemote: RemoteName;
  /** Tried in order only when the repository has no remotes at all. */
  readonly localBranches: ReadonlyArray<BranchName>;
}
export interface WorkspaceQueryOptions {
  readonly workspaceId: WorkspaceId;
  readonly defaultBase: DefaultBasePolicy;
}
export type ExpectedHead = { readonly _tag: "AnyHead" } | { readonly _tag: "Branch"; readonly name: BranchName };
export type HeadRelation = "unrestricted" | "matching" | "different";
export type IntegrationObservation =
  | { readonly _tag: "Assessed"; readonly assessment: IntegrationAssessment }
  | { readonly _tag: "NotAssessed"; readonly reason: "unexpected-head" | "unborn-head" | "unknown-default" | "missing-base" };
export type RepositoryWorkStatus =
  | { readonly _tag: "Browsing" }
  | { readonly _tag: "Unprepared" }
  | { readonly _tag: "Archived"; readonly association: AssociationState }
  | { readonly _tag: "Released"; readonly previous: WorktreeAssociation }
  | { readonly _tag: "Missing"; readonly worktree: WorktreeRef }
  | {
      readonly _tag: "Observed";
      readonly snapshot: WorktreeSnapshot;
      readonly expectedHead: ExpectedHead;
      readonly headRelation: HeadRelation;
      readonly integration: IntegrationObservation;
    };
export interface RepositoryWorkView {
  readonly changeId: ChangeId;
  readonly source: WorktreeRef;
  readonly intent: RepositoryIntent;
  readonly status: RepositoryWorkStatus;
}
export interface ChangeRepositoryInput {
  readonly changeId: ChangeId;
  readonly repository: RepositoryRef;
}
export class WorkingDirectoryUnavailable extends Data.TaggedError("WorkingDirectoryUnavailable")<{
  readonly changeId: ChangeId;
  readonly reason: "idea-not-started" | "not-prepared" | "released" | "finished";
}> {}

export class ChangeWorkspaceMismatch extends Data.TaggedError("ChangeWorkspaceMismatch")<{
  readonly changeId: ChangeId;
  readonly expected: WorkspaceId;
  readonly actual: WorkspaceId;
}> {}
export type ChangeLookupError = ChangeNotFound | RepositoryNotInChange | ChangeStoreError | ChangeWorkspaceMismatch;
export type ChangeInspectionError = ChangeLookupError | InspectionError | ReferenceError;
export type WorkingDirectoryError = ChangeLookupError | WorktreeIdentityError | WorkingDirectoryUnavailable;

export interface ChangeWorkQueriesApi {
  readonly inspectRepository: (input: ChangeRepositoryInput) => Effect.Effect<RepositoryWorkView, ChangeInspectionError>;
  /** Only resolves a location; does not create, attach, resume, or send terminal/agent input. */
  readonly resolveWorkingDirectory: (input: ChangeRepositoryInput) => Effect.Effect<AbsolutePath, WorkingDirectoryError>;
}
export class ChangeWorkQueries extends Context.Tag("corvi/workflows/ChangeWorkQueries")<ChangeWorkQueries, ChangeWorkQueriesApi>() {}
export declare const makeChangeWorkQueriesLayer: (options: WorkspaceQueryOptions) => Layer.Layer<
  ChangeWorkQueries, never, ChangeStore | Worktrees | References | History
>;

// Lifecycle facade: designed for subsequent extraction, not part of the read-only slice.
export type CompletionReasonKey = string & Brand.Brand<"corvi/CompletionReasonKey">;
export interface CompletionReason {
  /** Fingerprints the subject and observed facts, not just the display text. */
  readonly key: CompletionReasonKey;
  readonly subject: Option.Option<RepositoryRef>;
  readonly code: "idea" | "dirty-worktree" | "unavailable" | "ownership-unverified" | "shared-worktree" | "unexpected-head" | "review-pending" | "unpushed" | "provider-veto";
  readonly severity: "blocking" | "acknowledgeable";
}
export type CompletionAssessment =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "AcknowledgementRequired"; readonly reasons: ReadonlyArray<CompletionReason> }
  | { readonly _tag: "Blocked"; readonly reasons: ReadonlyArray<CompletionReason> };
export interface LifecycleWarning {
  readonly operation: string;
  readonly message: string;
}
export type FinishOutcome =
  | { readonly _tag: "Finished"; readonly changeId: ChangeId; readonly warnings: ReadonlyArray<LifecycleWarning> }
  | Exclude<CompletionAssessment, { readonly _tag: "Ready" }>;
export class ChangeOperationInProgress extends Data.TaggedError("ChangeOperationInProgress")<{
  readonly changeId: ChangeId;
}> {}
export class InvalidChangeTransition extends Data.TaggedError("InvalidChangeTransition")<{
  readonly changeId: ChangeId;
  readonly state: ChangeState;
}> {}
export class ChangeOperationFailed extends Data.TaggedError("ChangeOperationFailed")<{
  readonly changeId: ChangeId;
  readonly step: string;
  readonly reason: "storage" | "repository" | "provider" | "terminal";
  readonly message: string;
}> {}
export type LifecycleError = ChangeNotFound | InvalidChangeTransition | ChangeOperationInProgress | ChangeOperationFailed;
export interface FinishChangeInput {
  readonly changeId: ChangeId;
  readonly acknowledged: ReadonlyArray<CompletionReasonKey>;
}
export interface ChangeLifecycleApi {
  readonly startChange: (changeId: ChangeId) => Effect.Effect<{
    readonly changeId: ChangeId;
    readonly warnings: ReadonlyArray<LifecycleWarning>;
  }, LifecycleError>;
  readonly assessCompletion: (changeId: ChangeId) => Effect.Effect<CompletionAssessment, LifecycleError>;
  readonly completeChange: (input: FinishChangeInput) => Effect.Effect<FinishOutcome, LifecycleError>;
  readonly cancelChange: (input: FinishChangeInput) => Effect.Effect<FinishOutcome, LifecycleError>;
}
export class ChangeLifecycle extends Context.Tag("corvi/workflows/ChangeLifecycle")<ChangeLifecycle, ChangeLifecycleApi>() {}

/** A terminal-owned port used by lifecycle composition, not an implementation of tmux. */
export type TerminalSessionId = string & Brand.Brand<"corvi/TerminalSessionId">;
export class TerminalStopError extends Data.TaggedError("TerminalStopError")<{
  readonly sessionId: TerminalSessionId;
  readonly message: string;
}> {}
export interface TerminalSessionsApi {
  readonly stopSession: (sessionId: TerminalSessionId) => Effect.Effect<void, TerminalStopError>;
}
export class TerminalSessions extends Context.Tag("corvi/terminals/TerminalSessions")<TerminalSessions, TerminalSessionsApi>() {}

export type DefaultBase =
  | { readonly _tag: "Resolved"; readonly commit: CommitId }
  | { readonly _tag: "Unavailable"; readonly reason: "unknown-default" | "missing-base" };
export type DefaultBaseError = ReferenceError;
