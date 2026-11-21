import { expect, test } from "bun:test";
import { Effect, Result, Layer } from "effect";

import { ChangeService } from "@corvi/changes/changes";
import { ChangeRepositories } from "@corvi/changes/repositories";
import { Change, ChangeId, DirectoryName, Repository, RepositoryId } from "@corvi/contracts/changes";
import { CheckoutError, NotARepository, Repositories, type CheckoutInspection } from "@corvi/repositories";
import {
  ChangeWork,
  OperationProgress,
  describeCheckout,
  describeProvisionError,
  layer as changeWorkLayer,
  withCheckoutLock,
  type OperationStep,
} from "../src/change-work.ts";

interface Script {
  change: Change;
  links: Repository[];
  calls: string[];
  steps: OperationStep[];
  inspect: CheckoutInspection;
  inspectFailure?: CheckoutError;
  failAddFor?: string;
  /** Whether the scripted repositories have a remote to fetch (the default). */
  remote?: boolean;
  /** One repository whose fetch fails, by name — the "offline" case. */
  fetchFailsFor?: string;
  /** What the default branch reads, for a change branch with no base of its own. */
  defaultBranch?: string;
  /** What every scripted fast-forward answers. */
  forward?: import("@corvi/repositories").ForwardOutcome;
  /** Whether a named branch's remote counterpart exists (the default). */
  counterpart?: boolean;
  selected?: import("@corvi/repositories").ExistingBranch;
  /** Where a user or agent moved the checkout after provisioning — the refresh must not touch
   * it. */
  switchedTo?: string;
  inspectAfterProvision?: CheckoutInspection;
  /** The remote names `hasRemote` was asked about. */
  remotesAsked: string[];
  /** What each scripted provisioning left checked out, per directory. */
  branches: Map<string, string>;
  /** Whether the checkout holds uncommitted work. */
  dirty?: boolean;
  /** Give the scripted provisioning a moment, where a race would show. */
  slow?: boolean;
}

const change = (phase: Change["phase"]): Change =>
  new Change({
    changeId: ChangeId.make("example"),
    title: "Example",
    workspaceLocation: "/workspace/example",
    branch: "example",
    phase,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

const link = (
  directoryName: string,
  location: Repository["location"] = "new",
  branch: Repository["branch"] = { kind: "change" },
  extras: { readonly base?: string; readonly target?: string } = {},
): Repository =>
  new Repository({
    changeId: ChangeId.make("example"),
    repositoryId: RepositoryId.make(directoryName),
    directoryName: DirectoryName.make(directoryName),
    originalLocation: `/sources/${directoryName}`,
    location,
    branch,
    ...extras,
  });

const script = (overrides: Partial<Script> = {}): Script => ({
  change: change("Ideation"),
  links: [],
  calls: [],
  steps: [],
  inspect: { _tag: "Missing" },
  remotesAsked: [],
  branches: new Map(),
  ...overrides,
});

const layerFor = (state: Script): Layer.Layer<ChangeWork> =>
  changeWorkLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChangeService, {
          getChange: () => Effect.succeed(state.change),
          listChanges: () => Effect.succeed([]),
          createChange: () => Effect.succeed(state.change),
          transitionTo: (_changeId, phase) => {
            state.calls.push(`transition ${phase}`);
            state.change = new Change({
              ...state.change,
              phase,
              ...(phase === "Completed" || phase === "Cancelled" ? { completedAt: "then" } : {}),
            });
            return Effect.succeed(state.change);
          },
          reopen: () => Effect.die(new Error("reopen is not scripted")),
        }),
        Layer.succeed(ChangeRepositories, {
          listRepositories: () => Effect.succeed(state.links),
          addRepository: (input) =>
            Effect.succeed(
              new Repository({
                ...input,
                repositoryId: RepositoryId.make("link"),
                directoryName: DirectoryName.make("link"),
              }),
            ),
          removeRepository: () => Effect.void,
        }),
        Layer.succeed(Repositories, {
          // What the checkout run left there is what a later read sees — including where a user
          // moved it afterwards, which the refresh must leave alone.
          inspectCheckout: (directory) => {
            if (state.inspectFailure) return Effect.fail(state.inspectFailure);
            const provisioned = state.branches.get(String(directory));
            if (provisioned && state.inspectAfterProvision)
              return Effect.succeed(state.inspectAfterProvision);
            const observed = state.switchedTo ?? provisioned;
            return Effect.succeed(
              observed === undefined
                ? state.inspect
                : { _tag: "Present" as const, branch: observed, head: "abc" },
            );
          },
          assessRemoval: () => Effect.succeed({ _tag: "Safe" as const }),
          removeBranchIfIntegrated: () => Effect.succeed("deleted" as const),
          // The update-only facts are not this workflow's subject: called by mistake, they fail
          // visibly rather than answering an empty success.
          inspectUpstream: () => Effect.die(new Error("inspectUpstream is not scripted")),
          incomingCommits: () => Effect.die(new Error("incomingCommits is not scripted")),
          defaultRemoteBranch: () => Effect.die(new Error("defaultRemoteBranch is not scripted")),
          workingTreeDirty: () => Effect.succeed(state.dirty ?? false),
          pullFastForward: () => Effect.die(new Error("pullFastForward is not scripted")),
          captureWork: () => Effect.die(new Error("captureWork is not scripted")),
          discardWork: () => Effect.die(new Error("discardWork is not scripted")),
          applyWork: () => Effect.die(new Error("applyWork is not scripted")),
          inspectLocalChanges: () => Effect.die(new Error("inspectLocalChanges is not scripted")),
          countCommitsSince: () => Effect.die(new Error("countCommitsSince is not scripted")),
          diffFile: () => Effect.die(new Error("diffFile is not scripted")),
          commitPaths: () => Effect.die(new Error("commitPaths is not scripted")),
          pushBranch: () => Effect.die(new Error("pushBranch is not scripted")),
          provisionLinkedWorktree: (input) => {
            state.branches.set(
              String(input.directory),
              state.selected?.branch ??
                (input.branch.startsWith("origin/") ? input.branch.slice("origin/".length) : input.branch),
            );
            state.calls.push(
              `worktree ${input.directory} ${input.branch} ${input.createMissing ? "create" : "attach"}` +
                (input.base ? ` from ${input.base}` : ""),
            );
            const attempt =
              state.failAddFor && String(input.directory).endsWith(`/${state.failAddFor}`)
                ? Effect.fail(
                    new CheckoutError({
                      operation: "add-worktree",
                      directory: String(input.directory),
                      message: "worktree add failed",
                    }),
                  )
                : Effect.void;
            return state.slow ? attempt.pipe(Effect.delay("20 millis")) : attempt;
          },
          provisionInPlace: (input) => {
            state.branches.set(
              String(input.source),
              state.selected?.branch ??
                (input.branch.startsWith("origin/") ? input.branch.slice("origin/".length) : input.branch),
            );
            state.calls.push(
              `in-place ${input.branch} ${input.createMissing ? "create" : "attach"}` +
                (input.base ? ` from ${input.base}` : ""),
            );
            return Effect.succeed("created" as const);
          },
          hasRemote: (directory, remote) => {
            state.remotesAsked.push(remote ?? "(any)");
            return Effect.succeed(state.remote ?? true);
          },
          refExists: () => Effect.succeed(state.counterpart ?? true),
          resolveExistingBranch: (_source, name) =>
            Effect.succeed(
              state.selected ?? {
                branch: name.startsWith("origin/") ? name.slice("origin/".length) : name,
                ...((state.counterpart ?? true)
                  ? { remote: "origin", remoteRef: name.startsWith("origin/") ? name : `origin/${name}` }
                  : {}),
              },
            ),
          fetchRemote: (directory, remote) => {
            state.calls.push(`fetch ${directory}` + (remote && remote !== "origin" ? ` from ${remote}` : ""));
            return state.fetchFailsFor && String(directory).endsWith(`/${state.fetchFailsFor}`)
              ? Effect.fail(
                  new CheckoutError({
                    operation: "fetch",
                    directory: String(directory),
                    message: "could not resolve host",
                  }),
                )
              : Effect.void;
          },
          defaultBranch: () => Effect.succeed(state.defaultBranch ?? "origin/main"),
          fastForwardBranch: (input) => {
            state.calls.push(`forward ${input.directory} to ${input.to}`);
            return Effect.succeed(state.forward ?? ({ _tag: "Current" } as const));
          },
          removeWorktree: () => Effect.void,
        }),
        Layer.succeed(OperationProgress, {
          record: ({ step }) => {
            state.steps.push(step);
            return Effect.void;
          },
        }),
      ),
    ),
  );

const run = <A, E>(state: Script, program: Effect.Effect<A, E, ChangeWork>): Promise<Result.Result<A, E>> =>
  Effect.runPromise(program.pipe(Effect.result, Effect.provide(layerFor(state))));

const work = ChangeWork;

test("inspectChangeRepositories joins the change, its links, and the checkout facts", async () => {
  const expected = link("repo");
  const state = script({
    change: change("Implementation"),
    links: [expected],
    inspect: { _tag: "Present", branch: "example", head: "abc" },
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.inspectChangeRepositories(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success[0]).toEqual({
      repository: expected,
      state: "Active",
      checkoutLocation: "/workspace/example/repo",
      checkout: { _tag: "Present", branch: "example", head: "abc" },
    });
  }
});

test("inspection failures propagate", async () => {
  const state = script({
    change: change("Implementation"),
    links: [link("repo")],
    inspectFailure: new CheckoutError({
      operation: "inspect",
      directory: "/workspace/example/repo",
      message: "unreadable",
    }),
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.inspectChangeRepositories(ChangeId.make("example"));
    }),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("CheckoutError");
});

test("provisionChange runs the one policy for every repository", async () => {
  const state = script({ links: [link("repo")] });
  await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(state.calls).toEqual([
    "fetch /sources/repo",
    "worktree /workspace/example/repo example create",
    "forward /workspace/example/repo to origin/main",
  ]);
});

test("each checkout spec maps to its operation", async () => {
  const state = script({
    links: [
      link("adopted", "original", { kind: "current" }),
      link("switched", "original"),
      link("moved", "original", { kind: "existing", name: "feature" }),
      link("linked"),
      link("attached", "new", { kind: "existing", name: "feature" }),
      link("stacked", "new", { kind: "change" }, { base: "feature-a" }),
    ],
  });
  await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(state.calls).toEqual([
    // Adopting what the checkout has checked out is no work at all.
    // Freshness is one sequence per repository: fetch, provision, fast-forward-only.
    "fetch /sources/switched",
    "in-place example create",
    "forward /sources/switched to origin/main",
    "fetch /sources/moved",
    "in-place feature attach",
    "forward /sources/moved to origin/feature",
    "fetch /sources/linked",
    "worktree /workspace/example/linked example create",
    "forward /workspace/example/linked to origin/main",
    "fetch /sources/attached",
    "worktree /workspace/example/attached feature attach",
    "forward /workspace/example/attached to origin/feature",
    "fetch /sources/stacked",
    "worktree /workspace/example/stacked example create from feature-a",
    "forward /workspace/example/stacked to feature-a",
  ]);
});

test("a stored spec no validation would allow fails its own repository", async () => {
  // (new, current) is refused at the wire; a record written by hand can still hold one, and
  // then it is that repository's failure, not the run's.
  const state = script({ links: [link("impossible", "new", { kind: "current" })] });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success).toHaveLength(1);
    const failure = result.success[0]?.error;
    expect(failure).toBeDefined();
    expect(describeProvisionError(failure!)).toBe(
      "a new worktree cannot use the branch a source checkout has checked out",
    );
  }
});

test("a failed provision is reported per repository, and the others go on", async () => {
  const state = script({
    links: [link("good"), link("bad")],
    failAddFor: "bad",
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    const failed = result.success.filter((outcome) => outcome.error !== undefined);
    expect(failed.map((outcome) => outcome.repository.repositoryId)).toEqual([RepositoryId.make("bad")]);
    const provisioned = result.success.filter((outcome) => outcome.error === undefined);
    expect(provisioned.map((outcome) => outcome.repository.directoryName)).toEqual([
      DirectoryName.make("good"),
    ]);
  }
  expect(state.steps.map((step) => step.state)).toEqual(["running", "done", "running", "failed"]);
});

test("a clean run journals each repository as it finishes", async () => {
  const state = script({ links: [link("repo")] });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success[0]?.error).toBeUndefined();
  expect(state.steps.map((step) => step.state)).toEqual(["running", "done"]);
});

test("refreshRepository advances an existing branch to its own remote counterpart", async () => {
  const state = script({
    change: change("Implementation"),
    links: [link("repo", "new", { kind: "existing", name: "feature" })],
    inspect: { _tag: "Present", branch: "feature", head: "abc" },
    selected: { branch: "feature", remote: "origin", remoteRef: "origin/feature" },
    forward: { _tag: "Advanced", to: "origin/feature" },
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.refreshRepository(ChangeId.make("example"), RepositoryId.make("repo"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success).toEqual({ _tag: "Advanced", to: "origin/feature" });
  // Fetch first, then advance to the ref the policy selects — never the default branch.
  expect(state.calls).toEqual(["fetch /sources/repo", "forward /workspace/example/repo to origin/feature"]);
  expect(state.remotesAsked).toEqual(["origin"]);
});

test("refreshRepository provisions nothing: a missing or drifted checkout is left alone", async () => {
  const missing = script({ change: change("Implementation"), links: [link("repo")] });
  const missingResult = await run(
    missing,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.refreshRepository(ChangeId.make("example"), RepositoryId.make("repo"));
    }),
  );
  expect(Result.isSuccess(missingResult)).toBe(true);
  if (Result.isSuccess(missingResult))
    expect(missingResult.success).toEqual({ _tag: "LeftAlone", reason: "the checkout is not on example" });
  // No fetch, no worktree add: this action only ever moves a checkout that is there.
  expect(missing.calls).toEqual([]);

  const drifted = script({
    change: change("Implementation"),
    links: [link("repo")],
    inspect: { _tag: "Present", branch: "other", head: "abc" },
  });
  const driftedResult = await run(
    drifted,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.refreshRepository(ChangeId.make("example"), RepositoryId.make("repo"));
    }),
  );
  expect(Result.isSuccess(driftedResult)).toBe(true);
  if (Result.isSuccess(driftedResult))
    expect(driftedResult.success).toEqual({
      _tag: "LeftAlone",
      reason: "the checkout is on other, not example",
    });
  expect(drifted.calls).toEqual([]);

  const adopted = script({
    change: change("Implementation"),
    links: [link("repo", "original", { kind: "current" })],
  });
  const adoptedResult = await run(
    adopted,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.refreshRepository(ChangeId.make("example"), RepositoryId.make("repo"));
    }),
  );
  expect(Result.isSuccess(adoptedResult)).toBe(true);
  if (Result.isSuccess(adoptedResult))
    expect(adoptedResult.success).toEqual({
      _tag: "None",
      reason: "a branch adopted as checked out is never refreshed",
    });
  expect(adopted.calls).toEqual([]);
});

test("refreshRepository never moves over uncommitted work", async () => {
  const state = script({
    change: change("Implementation"),
    links: [link("repo")],
    inspect: { _tag: "Present", branch: "example", head: "abc" },
    dirty: true,
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.refreshRepository(ChangeId.make("example"), RepositoryId.make("repo"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result))
    expect(result.success).toEqual({
      _tag: "LeftAlone",
      reason: "uncommitted changes in the checkout",
    });
  // Refused before the fetch and the fast-forward: nothing was asked of the remote and nothing
  // was moved under the edits.
  expect(state.calls).toEqual([]);
});

test("describeProvisionError names a non-repository", () => {
  expect(describeProvisionError(new NotARepository({ directory: "/sources/repo" }))).toContain(
    "/sources/repo",
  );
});

test("a checkout someone switched away is never refreshed — and says it is not what was wanted", async () => {
  // The worktree is ordinary git: an agent or a user runs `git switch` inside it. The refresh
  // moves whatever is checked out, so a checkout not on the expected branch must not be touched
  // — and provisioning did not deliver what the change asked for, which a retry needs to hear
  // rather than read as a quiet success.
  const state = script({ links: [link("repo")], switchedTo: "other" });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    // Nothing is blocked: the repository reports what it found, and the run goes on.
    expect(describeProvisionError(result.success[0]!.error!)).toBe("the checkout is on other, not example");
    expect(result.success[0]?.refresh).toEqual({
      _tag: "LeftAlone",
      reason: "the checkout is on other, not example",
    });
  }
  expect(state.calls.some((call) => call.startsWith("forward"))).toBe(false);
});

test("the fetch asks about origin — the remote it fetches", async () => {
  // A repository whose only remote is another name has nothing this sequence fetches; asking
  // "any remote" and then fetching `origin` would fail the checkout over a remote it never uses.
  const state = script({ links: [link("repo")] });
  await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(state.remotesAsked).toEqual(["origin"]);
});

for (const remote of ["origin", "upstream"]) {
  for (const location of ["new", "original"] as const) {
    test(`a ${remote}-qualified selection in ${location} verifies the local name and refreshes the selected ref`, async () => {
      const state = script({
        links: [link("repo", location, { kind: "existing", name: `${remote}/team/topic` })],
        selected: { branch: "team/topic", remote, remoteRef: `${remote}/team/topic` },
      });
      const result = await run(
        state,
        Effect.gen(function* () {
          const changeWork = yield* work;
          return yield* changeWork.provisionChange(ChangeId.make("example"));
        }),
      );
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) expect(result.success[0]?.error).toBeUndefined();
      expect(state.remotesAsked).toEqual([remote]);
      const fetched = state.calls.findIndex((call) => call.startsWith("fetch"));
      const provisioned = state.calls.findIndex((call) =>
        call.startsWith(location === "new" ? "worktree" : "in-place"),
      );
      expect(fetched).toBeLessThan(provisioned);
      const directory = location === "new" ? "/workspace/example/repo" : "/sources/repo";
      expect(state.calls).toContain(`forward ${directory} to ${remote}/team/topic`);
      expect(state.calls.some((call) => call.includes("origin/origin/"))).toBe(false);
    });
  }
}

test("a detached destination is reported, never refreshed or silently repaired", async () => {
  const state = script({
    links: [link("repo", "new", { kind: "existing", name: "origin/feature" })],
    inspectAfterProvision: { _tag: "Present", head: "detached-work" },
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result))
    expect(result.success[0]?.error?.message).toBe("the checkout is not on feature");
  expect(state.calls.some((call) => call.startsWith("forward"))).toBe(false);
});

test("a local-only existing branch has nothing to fast-forward to", async () => {
  // An existing branch is refreshed toward its remote counterpart — but only when there is one.
  // A branch that was never pushed reports `none`, not a scary refusal over a missing ref.
  const state = script({
    links: [link("local", "new", { kind: "existing", name: "feature" })],
    counterpart: false,
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result))
    expect(result.success[0]?.refresh).toEqual({ _tag: "None", reason: "nothing to fast-forward to" });
  expect(state.calls.some((call) => call.startsWith("forward"))).toBe(false);
});

test("a fetch that will not answer stops that repository before anything is created", async () => {
  // Offline, DNS down: branching from refs that may be stale is exactly the failure this
  // replaces. The record survives, the other repository still provisions, and the stopped one
  // reports why.
  const state = script({ links: [link("good"), link("offline")], fetchFailsFor: "offline" });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    const stopped = result.success.find((outcome) => outcome.repository.directoryName === "offline");
    expect(describeProvisionError(stopped!.error!)).toBe("could not resolve host");
    expect(stopped?.refresh).toEqual({ _tag: "FetchFailed", reason: "could not resolve host" });
    expect(describeCheckout(stopped!)).toBe("fetch failed: could not resolve host");
  }
  expect(state.calls.filter((call) => call.startsWith("worktree"))).toEqual([
    "worktree /workspace/example/good example create",
  ]);
});

test("a refresh that cannot fast-forward reports and nothing else changes", async () => {
  // The branch has its own commits while the base moved on: the reconciliation is the user's,
  // and the run says so rather than failing.
  const state = script({
    links: [link("repo")],
    forward: { _tag: "LeftAlone", reason: "fatal: Not possible to fast-forward" },
  });
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success[0]?.error).toBeUndefined();
    expect(result.success[0]?.refresh).toEqual({
      _tag: "LeftAlone",
      reason: "fatal: Not possible to fast-forward",
    });
  }
  expect(state.steps.map((step) => step.detail)).toEqual([
    undefined,
    "left-alone: fatal: Not possible to fast-forward",
  ]);
});

test("the journal says what each refresh did", async () => {
  const state = script({ links: [link("repo")], forward: { _tag: "Advanced", to: "origin/main" } });
  await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work;
      return yield* changeWork.provisionChange(ChangeId.make("example"));
    }),
  );
  expect(state.steps.map((step) => `${step.state} ${step.detail ?? ""}`.trim())).toEqual([
    "running",
    "done advanced to origin/main",
  ]);
});

test("two checkout runs on one change queue rather than interleave", async () => {
  const state = script({ links: [link("repo")], slow: true });
  const oneRun = Effect.gen(function* () {
    const changeWork = yield* work;
    return yield* changeWork.provisionRepository(ChangeId.make("example"), RepositoryId.make("repo"));
  });
  // The server's checkout operations hold this lock across their whole run; the policy runs
  // inside it. Interleaved runs would record both `worktree` calls before either `forward`.
  await run(
    state,
    Effect.all(
      [
        withCheckoutLock(ChangeId.make("example"), oneRun),
        withCheckoutLock(ChangeId.make("example"), oneRun),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(state.calls.filter((call) => call.startsWith("worktree") || call.startsWith("forward"))).toEqual([
    "worktree /workspace/example/repo example create",
    "forward /workspace/example/repo to origin/main",
    "worktree /workspace/example/repo example create",
    "forward /workspace/example/repo to origin/main",
  ]);
});
