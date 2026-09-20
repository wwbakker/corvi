/** Tests the design examples only; there is no implemented Git/storage adapter here. */
import { expect, test } from "bun:test";
import { Brand, Effect, Layer, Option } from "effect";
import { ChangeNotFound, ChangeStore } from "../changes/api.ts";
import type { ChangeId, ChangeRevision, ChangeState, ChangeWorkState, RepositoryIntent, WorkspaceId } from "../changes/api.ts";
import { Repositories, RepositoryError } from "../repositories/api.ts";
import type { AbsolutePath, BranchName, CommitId, RemoteDefault, RemoteName, RepositoryRef, WorktreeHead, WorktreeRef, WorktreeSnapshot } from "../repositories/api.ts";
import type { ChangeInspectionError, ChangeRepositoryInput, WorkspaceQueryOptions, RepositoryWorkView, WorkingDirectoryError } from "./api.ts";
import { inspectChangeRepository, resolveChangeWorkingDirectory } from "./examples.ts";

const path: (value: string) => AbsolutePath = Brand.nominal<AbsolutePath>();
const branch: (value: string) => BranchName = Brand.nominal<BranchName>();
const commit: (value: string) => CommitId = Brand.nominal<CommitId>();
const remote: (value: string) => RemoteName = Brand.nominal<RemoteName>();
const changeId: ChangeId = Brand.nominal<ChangeId>()("example");
const repository: RepositoryRef = { commonGitDirectory: path("/fixture/source/.git") };
const source: WorktreeRef = { repository, directory: path("/fixture/source") };
const worktree: WorktreeRef = { repository, directory: path("/fixture/recorded-worktree") };
const input: ChangeRepositoryInput = { changeId, repository };
const workspaceId: WorkspaceId = Brand.nominal<WorkspaceId>()("workspace");
const policy: WorkspaceQueryOptions = {
  workspaceId,
  defaultBase: { preferredRemote: remote("origin"), localBranches: [branch("main"), branch("master")] },
};
const candidate: CommitId = commit("a".repeat(40));
const base: CommitId = commit("b".repeat(40));

interface FixtureOptions {
  readonly intent?: RepositoryIntent;
  readonly head?: WorktreeHead;
  readonly state?: ChangeState;
  readonly inspectMissing?: boolean;
  readonly verifyMissing?: boolean;
  readonly error?: RepositoryError;
  readonly remotes?: ReadonlyArray<RemoteName>;
  readonly remoteDefault?: RemoteDefault;
}
interface Fixture {
  readonly calls: string[];
  readonly layer: Layer.Layer<ChangeStore | Repositories>;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const calls: string[] = [];
  const intent: RepositoryIntent = options.intent ?? {
    _tag: "CreateLinkedWorktree", branch: branch("feature"), startFrom: { _tag: "DefaultBase" },
  };
  const state: ChangeWorkState = {
    id: changeId,
    revision: Brand.nominal<ChangeRevision>()(1),
    workspaceId,
    state: options.state ?? "In Progress",
    repositories: [{
      source: intent._tag === "UseExistingWorktree" ? worktree : source,
      intent,
      work: { _tag: "Bound", association: {
        worktree,
        origin: intent._tag === "UseExistingWorktree" ? "Borrowed" : "Created",
        createdBranch: intent._tag === "UseExistingWorktree" ? Option.none() : Option.some(branch("feature")),
      } },
    }],
  };
  const snapshot: WorktreeSnapshot = {
    ref: worktree,
    kind: "linked",
    head: options.head ?? { _tag: "Attached", branch: branch("feature"), commit: Option.some(candidate) },
    status: { staged: false, modified: false, untracked: false, conflicted: false },
    upstream: Option.none(),
  };
  const unexpected = (operation: string): Effect.Effect<never> => Effect.die(`Unscripted operation: ${operation}`);
  return {
    calls,
    layer: Layer.mergeAll(
      Layer.succeed(ChangeStore, {
        readWorkState: (id) => Effect.suspend(() => {
          calls.push("read-change");
          return id === changeId ? Effect.succeed(state) : Effect.fail(new ChangeNotFound({ changeId: id }));
        }),
        recordAssociation: () => unexpected("record-association"),
      }),
      Layer.succeed(Repositories, {
        resolveRepository: () => unexpected("resolve-repository"),
        resolveWorktree: () => unexpected("resolve-worktree"),
        listWorktrees: () => unexpected("list-worktrees"),
        verifyWorktree: (ref) => Effect.sync(() => {
          calls.push("verify-worktree");
          expect(ref).toEqual(worktree);
          return options.verifyMissing ? Option.none<WorktreeRef>() : Option.some(ref);
        }),
        inspectWorktree: (ref) => Effect.suspend(() => {
          calls.push("inspect-worktree");
          expect(ref).toEqual(worktree);
          if (options.error) return Effect.fail(options.error);
          return Effect.succeed(options.inspectMissing ? Option.none<WorktreeSnapshot>() : Option.some(snapshot));
        }),
        listRemotes: () => Effect.sync(() => {
          calls.push("list-remotes");
          return options.remotes ?? [];
        }),
        readRemoteDefault: () => Effect.sync(() => {
          calls.push("remote-default");
          return options.remoteDefault ?? { _tag: "Unknown" };
        }),
        resolveCommit: (_repository, revision) => Effect.sync(() => {
          calls.push(`resolve-${revision._tag}`);
          expect(revision).toEqual(options.remoteDefault?._tag === "Known"
            ? options.remoteDefault.revision
            : { _tag: "LocalBranch", name: branch("main") });
          return Option.some(base);
        }),
        assessIntegration: (_repository, commits) => Effect.sync(() => {
          calls.push("assess-integration");
          expect(commits).toEqual({ candidate, base });
          return { ...commits, _tag: "ProvenIntegrated", evidence: "ancestor" };
        }),
      }),
    ),
  };
}

test("design: a branch switch does not change the recorded working directory", async (): Promise<void> => {
  const env: Fixture = fixture({ head: { _tag: "Attached", branch: branch("other"), commit: Option.some(candidate) } });
  const view: RepositoryWorkView = await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.provide(env.layer)));
  expect(view.status).toMatchObject({ _tag: "Observed", headRelation: "different", integration: { _tag: "NotAssessed", reason: "unexpected-head" } });
  expect(env.calls).toEqual(["read-change", "inspect-worktree"]);
  env.calls.length = 0;
  expect(await Effect.runPromise(resolveChangeWorkingDirectory(input, workspaceId).pipe(Effect.provide(env.layer)))).toBe(worktree.directory);
  expect(env.calls).toEqual(["read-change", "verify-worktree"]);
});

test("design: keeping an existing detached HEAD is unrestricted and compares its pinned commit", async (): Promise<void> => {
  const env: Fixture = fixture({
    intent: { _tag: "UseExistingWorktree", head: { _tag: "KeepCurrentHead" } },
    head: { _tag: "Detached", commit: candidate },
  });
  const view: RepositoryWorkView = await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.provide(env.layer)));
  expect(view.status).toMatchObject({ _tag: "Observed", headRelation: "unrestricted", integration: { _tag: "Assessed", assessment: { candidate, base } } });
  expect(env.calls).not.toContain("list-worktrees");
});

test("design: an unborn branch is not evidence of integrated work", async (): Promise<void> => {
  const env: Fixture = fixture({ head: { _tag: "Attached", branch: branch("feature"), commit: Option.none() } });
  const view: RepositoryWorkView = await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.provide(env.layer)));
  expect(view.status).toMatchObject({ integration: { _tag: "NotAssessed", reason: "unborn-head" } });
  expect(env.calls).toEqual(["read-change", "inspect-worktree"]);
});

test("design: an unknown remote default does not trigger local fallback or integration assessment", async (): Promise<void> => {
  const env: Fixture = fixture({ remotes: [remote("origin")] });
  const view: RepositoryWorkView = await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.provide(env.layer)));
  expect(view.status).toMatchObject({ integration: { _tag: "NotAssessed", reason: "unknown-default" } });
  expect(env.calls).toEqual(["read-change", "inspect-worktree", "list-remotes", "remote-default"]);
});

test("design: only a definitive worktree miss becomes the Missing view", async (): Promise<void> => {
  const missing: Fixture = fixture({ inspectMissing: true });
  expect((await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.provide(missing.layer)))).status)
    .toEqual({ _tag: "Missing", worktree });
  const failed: Fixture = fixture({ error: new RepositoryError({ operation: "inspectWorktree", message: "denied" }) });
  const error: ChangeInspectionError = await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.flip, Effect.provide(failed.layer)));
  expect(error._tag).toBe("RepositoryError");
});

test("design: archived inspection does not touch Git or allow resolving an active working directory", async (): Promise<void> => {
  const env: Fixture = fixture({ state: "Completed" });
  expect((await Effect.runPromise(inspectChangeRepository(input, policy).pipe(Effect.provide(env.layer)))).status._tag).toBe("Archived");
  expect(env.calls).toEqual(["read-change"]);
  const error: WorkingDirectoryError = await Effect.runPromise(resolveChangeWorkingDirectory(input, workspaceId).pipe(Effect.flip, Effect.provide(env.layer)));
  expect(error).toMatchObject({ _tag: "WorkingDirectoryUnavailable", reason: "finished" });
  expect(env.calls).toEqual(["read-change", "read-change"]);
});

test("design: membership is checked before Git and is distinct from a missing change", async (): Promise<void> => {
  const env: Fixture = fixture();
  const error: ChangeInspectionError = await Effect.runPromise(inspectChangeRepository({ ...input, repository: { commonGitDirectory: path("/fixture/unrelated/.git") } }, policy).pipe(Effect.flip, Effect.provide(env.layer)));
  expect(error._tag).toBe("RepositoryNotInChange");
  expect(env.calls).toEqual(["read-change"]);
  const missing: ChangeInspectionError = await Effect.runPromise(inspectChangeRepository({ ...input, changeId: Brand.nominal<ChangeId>()("missing") }, policy).pipe(Effect.flip, Effect.provide(env.layer)));
  expect(missing._tag).toBe("ChangeNotFound");
});

test("design: a worktree that cannot be verified is an application-level unavailability, not a repository error", async (): Promise<void> => {
  const env: Fixture = fixture({ verifyMissing: true });
  const error: WorkingDirectoryError = await Effect.runPromise(resolveChangeWorkingDirectory(input, workspaceId).pipe(Effect.flip, Effect.provide(env.layer)));
  expect(error).toMatchObject({ _tag: "WorkingDirectoryUnavailable", reason: "missing-worktree" });
  expect(env.calls).toEqual(["read-change", "verify-worktree"]);
});

test("design: a workspace-bound query never observes a change using another workspace's services", async (): Promise<void> => {
  const env: Fixture = fixture();
  const error: ChangeInspectionError = await Effect.runPromise(inspectChangeRepository(input, {
    ...policy, workspaceId: Brand.nominal<WorkspaceId>()("another-workspace"),
  }).pipe(Effect.flip, Effect.provide(env.layer)));
  expect(error._tag).toBe("ChangeWorkspaceMismatch");
  expect(env.calls).toEqual(["read-change"]);
});
