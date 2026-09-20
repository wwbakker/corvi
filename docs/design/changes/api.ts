/** Design prototype: change-owned repository intent, associations, and storage. */
import { Context, Data } from "effect";
import type { Brand, Effect, Option, Schema } from "effect";
import type { BranchName, RepositoryRef, Revision, WorktreeRef } from "../repositories/api.ts";

// Shared values move to @corvi/contracts/changes and /git. The changes package imports
// their canonical schemas, not the repository capability's implementation or service tags.
export type ChangeId = string & Brand.Brand<"corvi/ChangeId">;
export type WorkspaceId = string & Brand.Brand<"corvi/WorkspaceId">;
export type ChangeRevision = number & Brand.Brand<"corvi/ChangeRevision">;
export declare const ChangeId: Schema.Schema<ChangeId, string>;
export declare const WorkspaceId: Schema.Schema<WorkspaceId, string>;
export declare const ChangeRevision: Schema.Schema<ChangeRevision, number>;

export type ChangeState = "Ideation" | "In Progress" | "Awaiting Review" | "Blocked" | "Completed" | "Cancelled";
export type StartingPoint = { readonly _tag: "DefaultBase" } | { readonly _tag: "Revision"; readonly revision: Revision };
export type ExistingHeadPolicy =
  | { readonly _tag: "KeepCurrentHead" }
  | { readonly _tag: "SwitchToBranch"; readonly branch: BranchName; readonly startFrom: StartingPoint };

/** Intent describes provisioning, not how to rediscover an established worktree. */
export type RepositoryIntent =
  | { readonly _tag: "CreateLinkedWorktree"; readonly branch: BranchName; readonly startFrom: StartingPoint }
  | { readonly _tag: "UseExistingWorktree"; readonly head: ExistingHeadPolicy };

export interface WorktreeAssociation {
  readonly worktree: WorktreeRef;
  /** Borrowed directories are never removed by completing/cancelling the change. */
  readonly origin: "Created" | "Borrowed" | "Unverified";
  /** A created worktree can hold a preexisting branch; their ownership is separate. */
  readonly createdBranch: Option.Option<BranchName>;
}
export type AssociationState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Bound"; readonly association: WorktreeAssociation }
  | { readonly _tag: "Released"; readonly previous: WorktreeAssociation };

export interface ChangeRepository {
  /** Original working directory used for browsing and as provisioning input. */
  readonly source: WorktreeRef;
  readonly intent: RepositoryIntent;
  readonly work: AssociationState;
}

/** Repository/lifecycle projection, not a replacement schema for the entire persisted Change. */
export interface ChangeWorkState {
  readonly id: ChangeId;
  readonly revision: ChangeRevision;
  readonly workspaceId: WorkspaceId;
  readonly state: ChangeState;
  readonly repositories: ReadonlyArray<ChangeRepository>;
}

export class ChangeNotFound extends Data.TaggedError("ChangeNotFound")<{
  readonly changeId: ChangeId;
}> {}
export class RepositoryNotInChange extends Data.TaggedError("RepositoryNotInChange")<{
  readonly changeId: ChangeId;
  readonly repository: RepositoryRef;
}> {}
/** Operational store failure: reported, not classified by reason. The structured outcomes
 * below stay because callers retry, reconcile, or explain them. */
export class ChangeStoreError extends Data.TaggedError("ChangeStoreError")<{
  readonly changeId: ChangeId;
  readonly operation: "read" | "record-association";
  readonly message: string;
  readonly cause?: unknown;
}> {}
export class ChangeConflict extends Data.TaggedError("ChangeConflict")<{
  readonly changeId: ChangeId;
  readonly expected: ChangeRevision;
  readonly actual: ChangeRevision;
}> {}
export class InvalidAssociation extends Data.TaggedError("InvalidAssociation")<{
  readonly changeId: ChangeId;
  readonly reason: "repository-mismatch" | "finished-change" | "invalid-transition";
}> {}

/** A projection read and a narrow atomic update, not whole-record replacement. */
export interface ChangeStoreApi {
  readonly readWorkState: (changeId: ChangeId) => Effect.Effect<ChangeWorkState, ChangeNotFound | ChangeStoreError>;
  /** Validates membership/state; preserves every unrelated field and increments the revision. */
  readonly recordAssociation: (input: {
    readonly changeId: ChangeId;
    readonly repository: RepositoryRef;
    readonly expectedRevision: ChangeRevision;
    readonly association: AssociationState;
  }) => Effect.Effect<ChangeWorkState, ChangeNotFound | RepositoryNotInChange | ChangeStoreError | ChangeConflict | InvalidAssociation>;
}
export class ChangeStore extends Context.Tag("corvi/changes/ChangeStore")<ChangeStore, ChangeStoreApi>() {}
