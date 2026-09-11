import { basename } from "node:path";
import { Effect } from "effect";
import type { Change } from "../../core/domain/change.ts";
import { removeWorktree, unsafeToRemove } from "../../integrations/git.ts";
import { archiveChange, writeChange } from "./store.ts";
import {
  afterChange,
  beforeChange,
  looseEndContributorsFor,
  type ProvisionResult,
} from "../../core/host/index.ts";
import { capabilitiesLayer } from "../../core/host/services.ts";
import { workspaceOf } from "../../workspaces.ts";
import { stopTerminal } from "../../terminal.ts";
import { BadRequestError, type CliError, type IweError } from "../../effect/errors.ts";
import { shSoft } from "../../effect/support.ts";

/**
 * Abandoning a change: the opposite end of `complete.ts`.
 *
 * Cancelling takes back what IWE made — the worktrees and the terminal — and touches nothing
 * that anyone else can see. The branches stay (wt keeps an unmerged one), the pull requests stay
 * open, the ticket stays where it is. That is deliberate: cancelling is a decision about your own
 * desk, and closing somebody else's pull request or moving a ticket other people are watching is
 * a decision about theirs. What is left is listed so you can go and deal with it — the loose
 * ends are gathered by asking the extensions (looseEnds, below).
 *
 * The protections are the same ones a repository removal has, because it is the same act:
 * uncommitted work refuses outright, commits nobody else has ask first.
 */

/** Names of the repositories whose work would be lost, when that needs asking about first.
 * The Effect API answers in one discriminated union that callers branch on by `_tag`; the
 * `NeedsForce` arm is the one that asks before losing commits nobody else has. */
export type NeedsForce = { _tag: "NeedsForce"; needsForce: string[] };
export type Cancelled = {
  _tag: "Done";
  change: Change;
  loose: string[];
  /** What the after-hooks reported, under each extension's name: collected, never fatal. */
  after: ProvisionResult[];
};

export const cancelChange = (
  change: Change,
  force = false,
): Effect.Effect<Cancelled | NeedsForce, IweError> =>
  Effect.gen(function* () {
    const unsafe = yield* Effect.forEach(
      change.repos,
      (repo) => Effect.map(unsafeToRemove(change, repo), (unsafe) => ({ repo, unsafe })),
      // Unbounded concurrency is deliberate: these per-repo checks are independent.
      { concurrency: "unbounded" },
    );

    // Uncommitted work cannot be recovered from anywhere, so it is never thrown away on the
    // strength of a menu item: commit it, or revert it, and then cancel.
    const dirty = unsafe.filter((u) => u.unsafe?.kind === "dirty");
    if (dirty.length) {
      return yield* new BadRequestError({
        message:
          `${dirty.map((d) => basename(d.repo)).join(", ")}: uncommitted changes, ` +
          `commit or revert them before cancelling`,
      });
    }
    // Commits nobody else has: the branch survives a cancellation, so these are recoverable — but
    // only by someone who knows the branch is there, which is worth one question.
    const unpushed = unsafe.filter((u) => u.unsafe?.kind === "unpushed");
    if (unpushed.length && !force) {
      return { _tag: "NeedsForce", needsForce: unpushed.map((u) => basename(u.repo)) };
    }

    // The before-hooks run before anything irreversible: a veto here leaves the change, its
    // worktrees and its terminal exactly as they were. They see the change, not a draft, so
    // their only move is to fail.
    yield* beforeChange("change:cancelling", change);

    // Asked before the worktrees go, because that is where the pull request is looked up from.
    const loose = yield* looseEnds(change);

    for (const repo of change.repos) yield* removeWorktree(change, repo);
    yield* stopTerminal(change.id);

    // Asked afterwards, because it is a fact about what is left: wt keeps a branch that has commits
    // nobody has seen and removes one that has nothing on it, and only the first is a loose end.
    const kept = yield* keptBranches(change);
    if (kept.length) {
      loose.push(`the branch ${change.branch} is kept in ${kept.map((repo) => basename(repo)).join(", ")}`);
    }

    const cancelled: Change = {
      ...change,
      state: "Cancelled",
      completedAt: new Date().toISOString(),
    };
    yield* writeChange(cancelled);
    yield* archiveChange(change.id);
    // The after-hooks observe the archived change. Their failures are reported under each
    // extension's name and never fail the cancellation.
    const after = yield* afterChange("change:cancelled", cancelled);
    return { _tag: "Done", change: cancelled, loose, after };
  });

/**
 * What cancelling deliberately leaves alone, said out loud.
 *
 * A cancelled change that quietly leaves an open pull request and a ticket in progress is a
 * change that comes back to you in a week as somebody else's question. Whose ends there are is
 * the extensions' business: every contributor of the change's workspace is asked, in extension
 * load order — so the pull-request lines (ci) precede the ticket line (jira). A contributor that
 * fails contributes nothing: cancelling must never fail because a vendor lookup did.
 */
export const looseEnds = (change: Change): Effect.Effect<string[]> =>
  Effect.map(
    Effect.forEach(
      looseEndContributorsFor(workspaceOf(change)),
      ({ name, contribution }) =>
        Effect.catchAll(
          Effect.provide(
            contribution.looseEnds(change),
            capabilitiesLayer(workspaceOf(change), name),
          ),
          () => Effect.succeed([] as string[]),
        ),
      // Unbounded concurrency is deliberate: these contributors are independent.
      { concurrency: "unbounded" },
    ),
    (ends) => ends.flat(),
  );

/**
 * Where the change's branch still exists once the worktrees are gone.
 *
 * wt keeps a branch that has commits nobody else has and removes one with nothing on it, which is
 * the behaviour you want and not the behaviour you would guess: worth reporting rather than
 * claiming either way.
 */
const keptBranches = (change: Change): Effect.Effect<string[]> =>
  Effect.map(
    Effect.forEach(
      change.repos,
      (repo) =>
        Effect.map(
          shSoft(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo),
          (exists) => (exists.code === 0 ? repo : undefined),
        ),
      // Unbounded concurrency is deliberate: these per-repo checks are independent.
      { concurrency: "unbounded" },
    ),
    (found) => found.filter((r): r is string => Boolean(r)),
  );
