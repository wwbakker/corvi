/** Design prototype: no production implementation. See ../repositories-and-changes.md. */
import { Context, Data } from "effect";
import type { Brand, Effect, Layer, Option, Schema } from "effect";

// Shared values move to @corvi/contracts/git and /paths. Schema declarations describe the
// constructor/codec boundary; they are not implemented validators in this prototype.
export type AbsolutePath = string & Brand.Brand<"corvi/AbsolutePath">;
export type BranchName = string & Brand.Brand<"corvi/BranchName">;
export type RemoteName = string & Brand.Brand<"corvi/RemoteName">;
export type TagName = string & Brand.Brand<"corvi/TagName">;
export type CommitId = string & Brand.Brand<"corvi/CommitId">;
export declare const AbsolutePath: Schema.Schema<AbsolutePath, string>;
export declare const BranchName: Schema.Schema<BranchName, string>;
export declare const RemoteName: Schema.Schema<RemoteName, string>;
export declare const TagName: Schema.Schema<TagName, string>;
export declare const CommitId: Schema.Schema<CommitId, string>;

/** A local location identity, not an enduring UUID or permission to mutate it. */
export interface RepositoryRef {
  readonly commonGitDirectory: AbsolutePath;
}

export interface RepositoryInfo {
  readonly ref: RepositoryRef;
  readonly storage: "bare" | "with-main-worktree";
}

/** Directory identity survives branch switches, but not an unrecorded move. */
export interface WorktreeRef {
  readonly repository: RepositoryRef;
  readonly directory: AbsolutePath;
}

export type WorktreeHead =
  | { readonly _tag: "Attached"; readonly branch: BranchName; readonly commit: Option.Option<CommitId> }
  | { readonly _tag: "Detached"; readonly commit: CommitId };

/** Registration is not proof that the directory exists or is accessible. */
export interface RegisteredWorktree {
  readonly ref: WorktreeRef;
  readonly kind: "main" | "linked";
  readonly head: WorktreeHead;
  readonly locked: Option.Option<string>;
  readonly prunable: Option.Option<string>;
}

/** No arbitrary revspec strings, implicit HEAD, or ambiguous short branch/tag names. */
export type Revision =
  | { readonly _tag: "LocalBranch"; readonly name: BranchName }
  | { readonly _tag: "RemoteBranch"; readonly remote: RemoteName; readonly name: BranchName }
  | { readonly _tag: "Tag"; readonly name: TagName }
  | { readonly _tag: "Commit"; readonly id: CommitId };

export type TrackingRevision = Extract<Revision, { readonly _tag: "LocalBranch" | "RemoteBranch" }>;

export interface WorkingTreeStatus {
  readonly staged: boolean;
  readonly modified: boolean;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

export type UpstreamComparison =
  | { readonly _tag: "Compared"; readonly ahead: number; readonly behind: number }
  | { readonly _tag: "Unavailable"; readonly reason: "unborn-head" | "missing-upstream" | "incomplete-history" };

export interface Upstream {
  readonly revision: TrackingRevision;
  readonly comparison: UpstreamComparison;
}

export interface WorktreeSnapshot {
  readonly ref: WorktreeRef;
  readonly kind: "main" | "linked";
  readonly head: WorktreeHead;
  readonly status: WorkingTreeStatus;
  /** None means no configured upstream, not a missing tracking ref or zero counts. */
  readonly upstream: Option.Option<Upstream>;
}

export type RemoteDefault =
  | { readonly _tag: "NotConfigured" }
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Known"; readonly revision: Extract<Revision, { readonly _tag: "RemoteBranch" }> };

export interface ComparedCommits {
  readonly candidate: CommitId;
  readonly base: CommitId;
}

/** Evidence about committed history only; never permission to remove a worktree or branch. */
export type IntegrationAssessment = ComparedCommits & (
  | { readonly _tag: "ProvenIntegrated"; readonly evidence: "ancestor" | "patch-equivalent-range" }
  | { readonly _tag: "NotProvenIntegrated"; readonly reason: "unmatched-patches"; readonly unmatchedPatchCount: number }
  | { readonly _tag: "NotProvenIntegrated"; readonly reason: "merge-history" | "no-comparable-patches" }
  | { readonly _tag: "Indeterminate"; readonly reason: "incomplete-history" }
);

export class NotARepository extends Data.TaggedError("NotARepository")<{
  readonly directory: AbsolutePath;
}> {}
export class NotAWorktree extends Data.TaggedError("NotAWorktree")<{
  readonly directory: AbsolutePath;
}> {}
export class WorktreeRepositoryMismatch extends Data.TaggedError("WorktreeRepositoryMismatch")<{
  readonly expected: WorktreeRef;
  readonly actual: RepositoryRef;
}> {}
export class WorktreeChangedDuringInspection extends Data.TaggedError("WorktreeChangedDuringInspection")<{
  readonly worktree: WorktreeRef;
}> {}
export class InvalidGitReference extends Data.TaggedError("InvalidGitReference")<{
  readonly value: string;
}> {}
export class RevisionIsNotACommit extends Data.TaggedError("RevisionIsNotACommit")<{
  readonly repository: RepositoryRef;
  readonly revision: Revision;
}> {}
export class RepositoryReadError extends Data.TaggedError("RepositoryReadError")<{
  readonly directory: AbsolutePath;
  readonly operation: string;
  readonly reason: "git-unavailable" | "timeout" | "access-denied" | "command-failed" | "invalid-output";
  /** Sanitized diagnostic, not argv, raw stderr, or credentials. */
  readonly message: string;
}> {}

export type DiscoveryError = NotARepository | RepositoryReadError;
export type WorktreeIdentityError = NotAWorktree | WorktreeRepositoryMismatch | RepositoryReadError;
export type InspectionError = WorktreeIdentityError | WorktreeChangedDuringInspection;
export type ReferenceError = InvalidGitReference | RevisionIsNotACommit | RepositoryReadError;

export interface RepositoriesApi {
  /** Accepts a worktree descendant or a Git directory. Canonicalizes the common directory. */
  readonly resolveRepository: (directory: AbsolutePath) => Effect.Effect<RepositoryInfo, DiscoveryError>;
}
export class Repositories extends Context.Tag("corvi/repositories/Repositories")<Repositories, RepositoriesApi>() {}

export interface WorktreesApi {
  /** Accepts a worktree descendant and returns its canonical root. Rejects Git-only directories. */
  readonly resolveWorktree: (directory: AbsolutePath) => Effect.Effect<WorktreeRef, NotAWorktree | RepositoryReadError>;
  /** Main first when present. Excludes the bare repository entry; includes stale registrations. */
  readonly listWorktrees: (repository: RepositoryRef) => Effect.Effect<ReadonlyArray<RegisteredWorktree>, RepositoryReadError>;
  /** Verifies exact root and repository membership without reading working-file status. */
  readonly verifyWorktree: (worktree: WorktreeRef) => Effect.Effect<WorktreeRef, WorktreeIdentityError>;
  /** Verifies identity and observes status; never redirects a stale ref to another worktree. */
  readonly inspectWorktree: (worktree: WorktreeRef) => Effect.Effect<WorktreeSnapshot, InspectionError>;
}
export class Worktrees extends Context.Tag("corvi/repositories/Worktrees")<Worktrees, WorktreesApi>() {}

export interface ReferencesApi {
  readonly listRemotes: (repository: RepositoryRef) => Effect.Effect<ReadonlyArray<RemoteName>, RepositoryReadError>;
  /** None means a missing/unborn ref. Existing non-commit targets are a distinct error. */
  readonly resolveCommit: (repository: RepositoryRef, revision: Revision) => Effect.Effect<Option.Option<CommitId>, ReferenceError>;
  /** Reads local remote configuration and symbolic HEAD; no network or ref updates. */
  readonly readRemoteDefault: (repository: RepositoryRef, remote: RemoteName) => Effect.Effect<RemoteDefault, InvalidGitReference | RepositoryReadError>;
}
export class References extends Context.Tag("corvi/repositories/References")<References, ReferencesApi>() {}

export interface HistoryApi {
  /** Uses pinned commits, not moving refs. No fetch, merge simulation, or object/ref writes. */
  readonly assessIntegration: (repository: RepositoryRef, commits: ComparedCommits) => Effect.Effect<IntegrationAssessment, RepositoryReadError>;
}
export class History extends Context.Tag("corvi/repositories/History")<History, HistoryApi>() {}

// Adapter-only entrypoints. These are not dependencies of browser consumers.
export class GitExecutionError extends Data.TaggedError("GitExecutionError")<{
  readonly reason: "spawn" | "timeout";
  readonly message: string;
}> {}
export class DirectoryResolutionError extends Data.TaggedError("DirectoryResolutionError")<{
  readonly directory: AbsolutePath;
  readonly reason: "missing" | "not-directory" | "access-denied";
}> {}
export interface GitObservationApi {
  /** Captured environment, bounded concurrency/timeout, raw output; nonzero exits are data. */
  readonly execute: (input: {
    readonly directory: AbsolutePath;
    readonly arguments: ReadonlyArray<string>;
  }) => Effect.Effect<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }, GitExecutionError>;
}
export class GitObservation extends Context.Tag("corvi/repositories/GitObservation")<GitObservation, GitObservationApi>() {}
export interface DirectoryResolutionApi {
  readonly canonicalizeDirectory: (directory: AbsolutePath) => Effect.Effect<AbsolutePath, DirectoryResolutionError>;
}
export class DirectoryResolution extends Context.Tag("corvi/repositories/DirectoryResolution")<DirectoryResolution, DirectoryResolutionApi>() {}

/** Construction captures dependencies. There is no cache or process between observations. */
export declare const repositoryQueriesLayer: Layer.Layer<
  Repositories | Worktrees | References | History,
  never,
  GitObservation | DirectoryResolution
>;
