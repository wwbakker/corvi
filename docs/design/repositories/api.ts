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

/**
 * The one public operational failure. Expected absence stays in the result as `None`; domain
 * outcomes (integration evidence, remote-default state, upstream comparison) stay structured.
 * Adapter errors are private and translated at the package boundary. Interruption is never
 * flattened into this error.
 */
export type RepositoryOperation =
  | "resolveRepository" | "resolveWorktree" | "listWorktrees" | "verifyWorktree"
  | "inspectWorktree" | "listRemotes" | "readRemoteDefault" | "resolveCommit"
  | "assessIntegration";
export class RepositoryError extends Data.TaggedError("RepositoryError")<{
  /** Safe to show to the user: names the subject and the failed operation, never credentials. */
  readonly message: string;
  readonly operation: RepositoryOperation;
  /** Diagnostics only: sanitized, never argv or raw stderr, never rendered. */
  readonly cause?: unknown;
}> {}

/**
 * The single capability service. The implementation stays split under worktrees/, references/,
 * history/, and git/; the consumer-facing tag is one because ownership, lifetime, and
 * substitution are the same for all of these observations. Consumers require only
 * `Repositories`.
 */
export interface RepositoriesApi {
  /** Some for a worktree descendant or a Git directory. None when the directory is definitively
   * not inside a repository. */
  readonly resolveRepository: (directory: AbsolutePath) => Effect.Effect<Option.Option<RepositoryInfo>, RepositoryError>;

  /** Some for a directory inside a worktree, canonicalized to its root. None for a Git-only/bare
   * directory or a definitively missing one. */
  readonly resolveWorktree: (directory: AbsolutePath) => Effect.Effect<Option.Option<WorktreeRef>, RepositoryError>;

  /** Registrations only: main first when present, stale/locked entries included, and no
   * per-directory status read. */
  readonly listWorktrees: (repository: RepositoryRef) => Effect.Effect<ReadonlyArray<RegisteredWorktree>, RepositoryError>;

  /** Some when the exact recorded root is a registered, usable worktree of that repository.
   * None when it is definitively gone, prunable, or not a worktree. No file-status scan. */
  readonly verifyWorktree: (worktree: WorktreeRef) => Effect.Effect<Option.Option<WorktreeRef>, RepositoryError>;

  /** Validated identity plus HEAD, status, and upstream. None when there is definitively no
   * usable worktree at the recorded location. One bounded identity/HEAD retry happens inside;
   * a persistent race is a RepositoryError, not a mixed snapshot. */
  readonly inspectWorktree: (worktree: WorktreeRef) => Effect.Effect<Option.Option<WorktreeSnapshot>, RepositoryError>;

  readonly listRemotes: (repository: RepositoryRef) => Effect.Effect<ReadonlyArray<RemoteName>, RepositoryError>;

  /** NotConfigured, Unknown, and Known stay distinct because callers choose different fallbacks. */
  readonly readRemoteDefault: (repository: RepositoryRef, remote: RemoteName) => Effect.Effect<RemoteDefault, RepositoryError>;

  /** None for a missing or unborn revision. A non-commit target (a tag to a tree or blob) is a
   * RepositoryError, not absence. */
  readonly resolveCommit: (repository: RepositoryRef, revision: Revision) => Effect.Effect<Option.Option<CommitId>, RepositoryError>;

  /** Uses pinned commits, not moving refs. No fetch, merge simulation, or object/ref writes. */
  readonly assessIntegration: (repository: RepositoryRef, commits: ComparedCommits) => Effect.Effect<IntegrationAssessment, RepositoryError>;
}
export class Repositories extends Context.Tag("corvi/repositories/Repositories")<Repositories, RepositoriesApi>() {}

// Adapter requirements, exported only from the composition entrypoint and never by the
// capability entrypoint. Their errors never appear in RepositoriesApi; the query Layer
// translates them at the package boundary.
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
export declare const repositoriesLayer: Layer.Layer<Repositories, never, GitObservation | DirectoryResolution>;
