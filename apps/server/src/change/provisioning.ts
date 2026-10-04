/** The change's checkout operations — the one server-side entry over the workflow's policy.
 *
 * The checkout work itself (fetch, provision, fast-forward-only) is the `ChangeWork` policy, and
 * this module gives it the presence the change directory needs around it: a browse link left at
 * a worktree's destination is dropped before, the configured tooling is copied and the in-place
 * links restored after. Creation, the repository list's edit, the row's action and Start work all
 * arrive here, so they cannot disagree about what a checkout is. Reads and removal live in
 * `../vendors/git.ts`; this module never sits in its import chain, so nothing cycles.
 */
import { basename } from "node:path";
import { Effect } from "effect";

import { ChangeId } from "@corvi/contracts/changes";
import { BadRequestError, type CliError } from "@corvi/contracts/errors";
import type {
  ChangeFormatTooNew,
  ChangeNotFound,
  ChangeStoreError,
  RepositoryNotFound,
  RepositoryStoreError,
} from "@corvi/changes/errors";
import { repositoryFromSpec } from "@corvi/changes/rules";
import {
  ChangeWork,
  describeCheckout,
  withCheckoutLock,
  type CheckoutOutcome,
  type RefreshReport,
} from "@corvi/workflows";
import { shOrThrow } from "../capabilities/shell.ts";
import { copyTooling } from "../capabilities/os.ts";
import {
  checkoutSpecProblem,
  duplicateRepoNames,
  type Change,
  type CheckoutSpec,
  type ProvisionResult,
} from "@corvi/changes/record";
import { runtimeConfig } from "../workspace/server/index.ts";
import {
  browseRepo,
  checkoutFor,
  openers,
  removeWorktree,
  unlinkRepo,
  unsafeToRemove,
  worktreePath,
} from "../vendors/git.ts";
import { changeWorkLayer } from "./lifecycle-layer.ts";
import { changePairs, writeChange } from "./server/store.ts";

/** What one repository's freshness step reported: advanced (fast-forward only), current,
 * left alone with git's own reason, a fetch that would not answer, or nothing to refresh. */
export type RefreshOutcome = {
  readonly repositoryId: string;
  readonly directoryName: string;
  readonly state: "advanced" | "current" | "left-alone" | "fetch-failed" | "none";
  readonly detail?: string;
};

/** What a checkout run reported back: the integration-level provisioning results and the
 * per-repository freshness outcomes. */
export type ProvisionRun = {
  readonly provision: readonly ProvisionResult[];
  readonly refresh: readonly RefreshOutcome[];
};

/** What can fail around the checkout work itself: the record's own store truths. A repository's
 * checkout problem is never here — those are reported per repository, in the run. */
export type CheckoutRunError =
  | ChangeFormatTooNew
  | ChangeNotFound
  | ChangeStoreError
  | RepositoryNotFound
  | RepositoryStoreError;

// Pure and synchronous: nothing for an Effect to wrap.
const refreshStateOf = (refresh: RefreshReport): RefreshOutcome["state"] => {
  switch (refresh._tag) {
    case "Advanced":
      return "advanced";
    case "Current":
      return "current";
    case "LeftAlone":
      return "left-alone";
    case "FetchFailed":
      return "fetch-failed";
    case "None":
      return "none";
  }
};

// Pure and synchronous: nothing for an Effect to wrap.
const refreshDetailOf = (refresh: RefreshReport): string | undefined => {
  switch (refresh._tag) {
    case "Advanced":
      return `to ${refresh.to}`;
    case "LeftAlone":
    case "FetchFailed":
    case "None":
      return refresh.reason;
    case "Current":
      return undefined;
  }
};

const refreshOutcomeOf = (report: CheckoutOutcome): RefreshOutcome => {
  const detail = refreshDetailOf(report.refresh);
  return {
    repositoryId: report.repository.repositoryId,
    directoryName: report.repository.directoryName,
    state: refreshStateOf(report.refresh),
    ...(detail ? { detail } : {}),
  };
};

/**
 * The presence a checkout run starts from: a browse link left at a worktree's destination goes
 * first. Following one would make git discover the source repository through it and read the
 * destination as the checkout the run is about to create — exactly the "agent on the main
 * worktree" failure this replaces.
 */
export const prepareCheckouts = (
  change: Change,
  specs: readonly CheckoutSpec[],
): Effect.Effect<void> =>
  Effect.forEach(
    specs.filter((spec) => spec.location === "new"),
    (spec) => unlinkRepo(change, spec.path),
    { concurrency: 1, discard: true },
  );

/** The presence a checkout run leaves: the configured tooling copied into each worktree (never
 * fatal — the worktree is the thing that was asked for), the in-place links restored, and the
 * reports built. */
export const finishCheckouts = (
  change: Change,
  reports: readonly CheckoutOutcome[],
): Effect.Effect<ProvisionRun> =>
  Effect.gen(function* () {
    for (const report of reports) {
      const source = report.repository.originalLocation;
      if (report.repository.location === "original") {
        yield* browseRepo(change, source);
        continue;
      }
      if (report.error || runtimeConfig().worktreeCopy.length === 0) continue;
      // Idempotent: existing destination settings are left alone, so a run that only refreshed
      // an existing worktree copies nothing over it.
      yield* copyTooling(source, worktreePath(change, source), runtimeConfig().worktreeCopy).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.error(`could not copy tooling into ${report.checkoutLocation}:`, error)),
        ),
      );
    }

    const failures = reports.filter((report) => report.error);
    const provision: readonly ProvisionResult[] = failures.length
      ? failures.map((report) => ({
          integration: "git",
          ok: false,
          error: `${report.repository.directoryName}: ${describeCheckout(report)}`,
        }))
      : [{ integration: "git", ok: true }];
    return { provision, refresh: reports.map(refreshOutcomeOf) };
  });

/**
 * Give the selected repositories their checkouts through the one policy: a worktree on the
 * change's branch, the repository's own checkout switched, or the checkout adopted as it is.
 * Without `paths` every repository runs (one journal entry each); with them, just those — a
 * repository edit provisioning what it added, the row's action retrying one.
 *
 * The record was written first and survives a failing repository: what stops is that
 * repository's checkout, reported per repository so it can be addressed and retried. The whole
 * run — presence, checkouts, reports — is one per-change critical section.
 */
export const provisionRepositories = (
  change: Change,
  paths?: readonly string[],
): Effect.Effect<ProvisionRun, CheckoutRunError> =>
  withCheckoutLock(
    ChangeId.make(change.id),
    runCheckouts(change, paths).pipe(Effect.provide(changeWorkLayer(changePairs()))),
  );

/** The checkout work without the lock, for the operations that hold it across more than this:
 * a repository edit tears down and provisions in one section. */
const runCheckouts = (
  change: Change,
  paths?: readonly string[],
): Effect.Effect<ProvisionRun, CheckoutRunError, ChangeWork> =>
  Effect.gen(function* () {
    const work = yield* ChangeWork;
    const wanted = new Set(paths);
    const specs = (change.checkouts ?? []).filter((spec) => paths === undefined || wanted.has(spec.path));
    yield* prepareCheckouts(change, specs);

    const reports: CheckoutOutcome[] = [];
    if (paths === undefined) {
      reports.push(...(yield* work.provisionChange(ChangeId.make(change.id))));
    } else {
      for (const spec of specs) {
        const link = repositoryFromSpec(ChangeId.make(change.id), spec);
        reports.push(yield* work.provisionRepository(link.changeId, link.repositoryId));
      }
    }
    return yield* finishCheckouts(change, reports);
  });

/**
 * Apply a new checkout list in one go: everything added gets its checkout, everything dropped
 * loses one. Nothing is destroyed without a word: uncommitted work in a worktree that would be
 * removed is the one refusal — that work would be lost — and every other removal is a question
 * the caller confirms or abandons.
 *
 * The list may be emptied. A change with no repositories is not much of a change, but it is a
 * step on the way to one: taking a repository out and putting it back is how you get a fresh
 * worktree when the one you have is beyond saving, and refusing the middle of that made the whole
 * thing impossible. The protections that matter — uncommitted work, unpushed commits — are per
 * repository and still apply.
 */
export type SetReposResult =
  | {
      readonly _tag: "Done"
      readonly change: Change
      readonly provision: readonly ProvisionResult[]
      readonly refresh: readonly RefreshOutcome[]
    }
  | { readonly _tag: "NeedsForce"; readonly needsForce: string[] };

// Pure and synchronous: nothing for an Effect to wrap.
const sameSpec = (a: CheckoutSpec, b: CheckoutSpec): boolean =>
  a.path === b.path &&
  a.location === b.location &&
  a.branch.kind === b.branch.kind &&
  (a.branch.kind === "existing" && b.branch.kind === "existing"
    ? a.branch.name === b.branch.name
    : true) &&
  (a.base ?? "") === (b.base ?? "") &&
  (a.target ?? "") === (b.target ?? "");

export const setRepos = (
  change: Change,
  specs: CheckoutSpec[],
  force = false,
): Effect.Effect<SetReposResult, CliError | BadRequestError | CheckoutRunError> =>
  Effect.gen(function* () {
    // Whitespace is nothing, and the same path twice is a double click rather than two
    // repositories: the first mention wins.
    const wanted = [
      ...new Map(
        specs
          .map((spec) => ({ ...spec, path: spec.path.trim() }))
          .map((spec) => [spec.path, spec] as const),
      ).values(),
    ].filter((spec) => spec.path);
    for (const spec of wanted) {
      const problem = checkoutSpecProblem(spec);
      if (problem) return yield* new BadRequestError({ message: problem });
    }
    // Every repository is filed in the change directory under its own name, so two paths with the
    // same name would collide there — a worktree on top of a worktree, or two browse links.
    const duplicate = duplicateRepoNames(wanted.map((spec) => spec.path));
    if (duplicate.length) {
      return yield* new BadRequestError({
        message:
          `two repositories share the name ${duplicate.join(", ")}: Corvi files each repository ` +
          `under its own name in the change directory`,
      });
    }
    const current = change.checkouts ?? [];
    const wantedByPath = new Map(wanted.map((spec) => [spec.path, spec]));
    const currentByPath = new Map(current.map((spec) => [spec.path, spec]));
    // A row whose spec changed is set up again the new way, and whatever it leaves is torn
    // down: the existing worktree or checkout is as wrong as a repository that was dropped.
    const teardown = current.filter((spec) => {
      const next = wantedByPath.get(spec.path);
      return next === undefined || !sameSpec(spec, next);
    });
    const setup = wanted.filter((spec) => {
      const prior = currentByPath.get(spec.path);
      return prior === undefined || !sameSpec(prior, spec);
    });

    // What leaving behind is worth asking about. A worktree goes, its branch stays unless its
    // work is proven landed; a checkout used where it is is left exactly as it stands. So the
    // question is the same for both — the only refusal is destroying uncommitted work.
    const questions: string[] = [];
    const lost: string[] = [];
    for (const spec of teardown) {
      const unsafe = yield* unsafeToRemove(change, spec.path);
      if (!unsafe) continue;
      if (unsafe.kind === "dirty" && spec.location === "new") lost.push(basename(spec.path));
      else questions.push(basename(spec.path));
    }
    if (lost.length) {
      return yield* new BadRequestError({
        message: `${lost.join(", ")}: uncommitted changes, revert or commit them first`,
      });
    }
    if (questions.length && !force) {
      return { _tag: "NeedsForce", needsForce: questions } satisfies SetReposResult;
    }

    // Teardown, record write and the checkout run are one per-change critical section: a
    // creation or a start racing this edit must not meet a half-torn repository. What the
    // checkouts then reported rides along with the edit — a failed repository is the caller's
    // to show, never a silent "Done".
    return yield* withCheckoutLock(
      ChangeId.make(change.id),
      Effect.gen(function* () {
        for (const spec of teardown) yield* removeWorktree(change, spec.path);
        const updated: Change = { ...change, checkouts: wanted };
        yield* writeChange(updated);
        const run = yield* runCheckouts(updated, setup.map((spec) => spec.path)).pipe(
          Effect.provide(changeWorkLayer(changePairs())),
        );
        return {
          _tag: "Done",
          change: updated,
          provision: run.provision,
          refresh: run.refresh,
        } satisfies SetReposResult;
      }),
    );
  });

/** The `git` integration's action runner, in Effect. */
export const gitRun = (
  change: Change,
  action: string,
  repo?: string,
): Effect.Effect<void, CliError | BadRequestError | CheckoutRunError> =>
  Effect.gen(function* () {
    if (!repo) {
      return yield* new BadRequestError({ message: "repo required" });
    }
    if (action === "add") {
      const run = yield* provisionRepositories(change, [repo]);
      // A click deserves an answer: a checkout that failed is the action's failure, as it was
      // before the consolidation — the row stays and its action is the retry.
      const failed = run.provision.filter((result) => !result.ok);
      if (failed.length > 0)
        return yield* new BadRequestError({
          message: failed.map((result) => result.error ?? "checkout failed").join("; "),
        });
      return;
    }

    // Opening: the worktree when there is one, the repository itself when it is used in place.
    const opener = openers.find((o) => o.id === action);
    if (opener) {
      const path = (yield* checkoutFor(change, repo)) ?? repo;
      yield* shOrThrow(opener.command(path));
      return;
    }

    // --force because build artifacts are untracked files and this button was clicked
    // deliberately. Removal is checkout work like provisioning: one run per change.
    if (action === "remove")
      return yield* withCheckoutLock(ChangeId.make(change.id), removeWorktree(change, repo));
    return yield* new BadRequestError({ message: `unknown git action: ${action}` });
  });
