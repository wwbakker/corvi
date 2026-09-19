/** Negative compile checks for the proposal. Never invoked by the application or test runner. */
import type { Effect } from "effect";
import type { ChangeStore } from "./changes/api.ts";
import type { ChangeRepositoryInput, WorkspaceQueryOptions, ChangeInspectionError, RepositoryWorkView } from "./workflows/api.ts";
import { inspectChangeRepository } from "./workflows/examples.ts";
import type { BranchName, CommitId, History, HistoryApi, References, RepositoryRef, WorktreeRef, Worktrees, WorktreesApi } from "./repositories/api.ts";

export function checkRepositoryTypes(
  repository: RepositoryRef,
  worktree: WorktreeRef,
  branch: BranchName,
  commit: CommitId,
  worktrees: WorktreesApi,
  history: HistoryApi,
): void {
  // @ts-expect-error A branch query is not a worktree's identity.
  void worktrees.inspectWorktree({ repository, branch });
  // @ts-expect-error A working-directory path is not a repository identity.
  void worktrees.listWorktrees(worktree.directory);
  // @ts-expect-error Integration evidence compares pinned commits, not moving branch names.
  void history.assessIntegration(repository, { candidate: branch, base: commit });
  // @ts-expect-error Public worktree references are immutable.
  worktree.directory = worktree.directory;
}

export function checkWorkflowRequirements(input: ChangeRepositoryInput, options: WorkspaceQueryOptions): void {
  const effect: Effect.Effect<RepositoryWorkView, ChangeInspectionError, ChangeStore | Worktrees | References | History> =
    inspectChangeRepository(input, options);
  // @ts-expect-error This workflow cannot run without its explicitly required services.
  const withoutServices: Effect.Effect<RepositoryWorkView, ChangeInspectionError> = effect;
  void withoutServices;
}
