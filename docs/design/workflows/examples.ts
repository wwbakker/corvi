/** Typechecked acceptance examples, not production workflows. No code runs on import. */
import { Effect, Option } from "effect";
import { Repositories } from "../repositories/api.ts";
import type {
  AbsolutePath, CommitId, IntegrationAssessment, RemoteDefault, RemoteName, RepositoriesApi,
  RepositoryRef, WorktreeHead, WorktreeRef, WorktreeSnapshot,
} from "../repositories/api.ts";
import { ChangeStore, RepositoryNotInChange } from "../changes/api.ts";
import type { ChangeRepository, ChangeStoreApi, ChangeWorkState, RepositoryIntent, WorkspaceId } from "../changes/api.ts";
import { ChangeWorkspaceMismatch, WorkingDirectoryUnavailable } from "./api.ts";
import type {
  ChangeInspectionError, ChangeLookupError, ChangeRepositoryInput, DefaultBase, DefaultBaseError,
  DefaultBasePolicy, ExpectedHead, HeadRelation, IntegrationObservation, RepositoryWorkStatus,
  RepositoryWorkView, WorkingDirectoryError, WorkspaceQueryOptions,
} from "./api.ts";

interface BindingContext {
  readonly change: ChangeWorkState;
  readonly binding: ChangeRepository;
}

const requireBinding = (input: ChangeRepositoryInput, workspaceId: WorkspaceId): Effect.Effect<BindingContext, ChangeLookupError, ChangeStore> =>
  Effect.gen(function* () {
    const changes: ChangeStoreApi = yield* ChangeStore;
    const change: ChangeWorkState = yield* changes.readWorkState(input.changeId);
    if (change.workspaceId !== workspaceId)
      return yield* new ChangeWorkspaceMismatch({ changeId: change.id, expected: workspaceId, actual: change.workspaceId });
    const binding: ChangeRepository | undefined = change.repositories.find((item) =>
      item.source.repository.commonGitDirectory === input.repository.commonGitDirectory);
    if (!binding) return yield* new RepositoryNotInChange(input);
    return { change, binding };
  });

export function expectedHeadFor(intent: RepositoryIntent): ExpectedHead {
  if (intent._tag === "CreateLinkedWorktree") return { _tag: "Branch", name: intent.branch };
  return intent.head._tag === "SwitchToBranch"
    ? { _tag: "Branch", name: intent.head.branch }
    : { _tag: "AnyHead" };
}

export function compareHead(expected: ExpectedHead, observed: WorktreeHead): HeadRelation {
  if (expected._tag === "AnyHead") return "unrestricted";
  return observed._tag === "Attached" && observed.branch === expected.name ? "matching" : "different";
}

/** Application default-base policy, deliberately not a Git service's idea of a default branch. */
export const resolveDefaultBase = (
  repository: RepositoryRef,
  policy: DefaultBasePolicy,
  repositories: RepositoriesApi,
): Effect.Effect<DefaultBase, DefaultBaseError> =>
  Effect.gen(function* () {
    const remotes: ReadonlyArray<RemoteName> = yield* repositories.listRemotes(repository);
    if (remotes.length > 0) {
      if (!remotes.includes(policy.preferredRemote)) return { _tag: "Unavailable", reason: "unknown-default" };
      const remote: RemoteDefault = yield* repositories.readRemoteDefault(repository, policy.preferredRemote);
      if (remote._tag !== "Known") return { _tag: "Unavailable", reason: "unknown-default" };
      const commit: Option.Option<CommitId> = yield* repositories.resolveCommit(repository, remote.revision);
      return Option.isSome(commit)
        ? { _tag: "Resolved", commit: commit.value }
        : { _tag: "Unavailable", reason: "missing-base" };
    }
    for (const name of policy.localBranches) {
      const commit: Option.Option<CommitId> = yield* repositories.resolveCommit(repository, { _tag: "LocalBranch", name });
      if (Option.isSome(commit)) return { _tag: "Resolved", commit: commit.value };
    }
    return { _tag: "Unavailable", reason: "unknown-default" };
  });

/** Returns domain facts. A web presenter, not this workflow, creates labels/colors/buttons. */
export const inspectChangeRepository = (
  input: ChangeRepositoryInput,
  options: WorkspaceQueryOptions,
): Effect.Effect<RepositoryWorkView, ChangeInspectionError, ChangeStore | Repositories> =>
  Effect.gen(function* () {
    const { change, binding } = yield* requireBinding(input, options.workspaceId);
    const repositories: RepositoriesApi = yield* Repositories;
    const view = (status: RepositoryWorkStatus): RepositoryWorkView => ({
      changeId: change.id, source: binding.source, intent: binding.intent, status,
    });
    if (change.state === "Ideation") return view({ _tag: "Browsing" });
    if (change.state === "Completed" || change.state === "Cancelled")
      return view({ _tag: "Archived", association: binding.work });
    if (binding.work._tag === "Pending") return view({ _tag: "Unprepared" });
    if (binding.work._tag === "Released") return view({ _tag: "Released", previous: binding.work.previous });

    const observed: Option.Option<WorktreeSnapshot> = yield* repositories.inspectWorktree(binding.work.association.worktree);
    if (Option.isNone(observed)) return view({ _tag: "Missing", worktree: binding.work.association.worktree });
    const snapshot: WorktreeSnapshot = observed.value;
    const expectedHead: ExpectedHead = expectedHeadFor(binding.intent);
    const headRelation: HeadRelation = compareHead(expectedHead, snapshot.head);
    const observedView = (integration: IntegrationObservation): RepositoryWorkView =>
      view({ _tag: "Observed", snapshot, expectedHead, headRelation, integration });
    if (headRelation === "different") return observedView({ _tag: "NotAssessed", reason: "unexpected-head" });

    const candidate: Option.Option<CommitId> = snapshot.head._tag === "Attached" ? snapshot.head.commit : Option.some(snapshot.head.commit);
    if (Option.isNone(candidate)) return observedView({ _tag: "NotAssessed", reason: "unborn-head" });
    const base: DefaultBase = yield* resolveDefaultBase(snapshot.ref.repository, options.defaultBase, repositories);
    if (base._tag === "Unavailable") return observedView({ _tag: "NotAssessed", reason: base.reason });
    const assessment: IntegrationAssessment = yield* repositories.assessIntegration(snapshot.ref.repository, { candidate: candidate.value, base: base.commit });
    return observedView({ _tag: "Assessed", assessment });
  });

/** Resolves an established association, even after a branch switch or detach. It starts nothing. */
export const resolveChangeWorkingDirectory = (
  input: ChangeRepositoryInput,
  workspaceId: WorkspaceId,
): Effect.Effect<AbsolutePath, WorkingDirectoryError, ChangeStore | Repositories> =>
  Effect.gen(function* () {
    const { change, binding } = yield* requireBinding(input, workspaceId);
    if (change.state === "Ideation")
      return yield* new WorkingDirectoryUnavailable({ changeId: change.id, reason: "idea-not-started" });
    if (change.state === "Completed" || change.state === "Cancelled")
      return yield* new WorkingDirectoryUnavailable({ changeId: change.id, reason: "finished" });
    if (binding.work._tag === "Pending")
      return yield* new WorkingDirectoryUnavailable({ changeId: change.id, reason: "not-prepared" });
    if (binding.work._tag === "Released")
      return yield* new WorkingDirectoryUnavailable({ changeId: change.id, reason: "released" });
    const repositories: RepositoriesApi = yield* Repositories;
    const verified: Option.Option<WorktreeRef> = yield* repositories.verifyWorktree(binding.work.association.worktree);
    if (Option.isNone(verified))
      return yield* new WorkingDirectoryUnavailable({ changeId: change.id, reason: "missing-worktree" });
    return verified.value.directory;
  });
