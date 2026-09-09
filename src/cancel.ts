import { basename } from "node:path";
import { Effect } from "effect";
import type { Change } from "./types.ts";
import { removeWorktreeEffect, unsafeToRemoveEffect } from "./integrations/git.ts";
import { prSummaryEffect } from "./integrations/github.ts";
import { archiveChangeEffect, writeChangeEffect } from "./changes.ts";
import { stopTerminalEffect } from "./terminal.ts";
import { shEffect, type Result } from "./sh.ts";
import { BadRequestError, type CliError } from "./effect/errors.ts";

/** The Result-branching contract of the old sh(), kept: non-zero exits are data, so a timed-out
 * CLI — the one failure shEffect can raise — surfaces as exit code 124 with its message, which
 * is what the Promise facade converts it to. Result-branching callers keep branching. */
const shSoft = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  Effect.catchAll(shEffect(cmd, cwd), (e) =>
    Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr }));

/** A failure's message, exactly as the old `e instanceof Error ? e.message : String(e)` read it:
 * every typed error carries the sentence users saw before. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Abandoning a change: the opposite end of `complete.ts`.
 *
 * Cancelling takes back what IWE made — the worktrees and the terminal — and touches nothing
 * that anyone else can see. The branches stay (wt keeps an unmerged one), the pull requests stay
 * open, the ticket stays where it is. That is deliberate: cancelling is a decision about your own
 * desk, and closing somebody else's pull request or moving a ticket other people are watching is
 * a decision about theirs. What is left is listed so you can go and deal with it.
 *
 * The protections are the same ones a repository removal has, because it is the same act:
 * uncommitted work refuses outright, commits nobody else has ask first.
 */
export type Cancellation = {
  change: Change;
  /** What cancelling did not take care of, in the words you would need to go and finish it. */
  loose: string[];
};

/** Names of the repositories whose work would be lost, when that needs asking about first.
 * The Effect API answers in one discriminated union where the old code returned a duck that the
 * caller probed with `"needsForce" in result`; the Promise facade keeps the duck (the server
 * still tests for it). */
export type NeedsForce = { _tag: "NeedsForce"; needsForce: string[] };
export type Cancelled = { _tag: "Done"; change: Change; loose: string[] };

export const cancelChangeEffect = (
  change: Change,
  force = false,
): Effect.Effect<Cancelled | NeedsForce, CliError | BadRequestError> =>
  Effect.gen(function* () {
    const unsafe = yield* Effect.forEach(
      change.repos,
      (repo) => Effect.map(unsafeToRemoveEffect(change, repo), (unsafe) => ({ repo, unsafe })),
      // The old Promise.all was unbounded, so this stays unbounded.
      { concurrency: "unbounded" },
    );

    // Uncommitted work cannot be recovered from anywhere, so it is never thrown away on the
    // strength of a menu item: commit it, or revert it, and then cancel.
    const dirty = unsafe.filter((u) => u.unsafe?.kind === "dirty");
    if (dirty.length) {
      return yield* Effect.fail(
        new BadRequestError({
          message:
            `${dirty.map((d) => basename(d.repo)).join(", ")}: uncommitted changes, ` +
            `commit or revert them before cancelling`,
        }),
      );
    }
    // Commits nobody else has: the branch survives a cancellation, so these are recoverable — but
    // only by someone who knows the branch is there, which is worth one question.
    const unpushed = unsafe.filter((u) => u.unsafe?.kind === "unpushed");
    if (unpushed.length && !force) {
      return { _tag: "NeedsForce", needsForce: unpushed.map((u) => basename(u.repo)) };
    }

    // Asked before the worktrees go, because that is where the pull request is looked up from.
    const loose = yield* looseEndsEffect(change);

    for (const repo of change.repos) yield* removeWorktreeEffect(change, repo);
    yield* stopTerminalEffect(change.id);

    // Asked afterwards, because it is a fact about what is left: wt keeps a branch that has commits
    // nobody has seen and removes one that has nothing on it, and only the first is a loose end.
    const kept = yield* keptBranchesEffect(change);
    if (kept.length) {
      loose.push(`the branch ${change.branch} is kept in ${kept.map((repo) => basename(repo)).join(", ")}`);
    }

    const cancelled: Change = {
      ...change,
      state: "Cancelled",
      completedAt: new Date().toISOString(),
    };
    yield* writeChangeEffect(cancelled);
    yield* archiveChangeEffect(change.id);
    return { _tag: "Done", change: cancelled, loose };
  });

/** Promise facade over cancelChangeEffect, in the duck-typed shape the old code returned.
 * Kept for the test suite, which drives the duck (`{ needsForce }` / `{ change, loose }`) and
 * the thrown plain Errors, and must pass unmodified. */
export async function cancelChange(
  change: Change,
  force = false,
): Promise<Cancellation | { needsForce: string[] }> {
  const result = await Effect.runPromise(cancelChangeEffect(change, force));
  return result._tag === "Done" ? { change: result.change, loose: result.loose } : { needsForce: result.needsForce };
}

/**
 * What cancelling deliberately leaves alone, said out loud.
 *
 * A cancelled change that quietly leaves an open pull request and a ticket in progress is a
 * change that comes back to you in a week as somebody else's question.
 */
const looseEndsEffect = (change: Change): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const ends: string[] = [];
    if (change.jira) ends.push(`${change.jira} is still open in Jira`);

    const prs = yield* Effect.forEach(
      change.repos,
      (repo) =>
        Effect.map(
          // Best effort: a repository with no pull request, or no network, is not a loose end worth
          // failing a cancellation over.
          Effect.catchAll(prSummaryEffect(change, repo), () => Effect.succeed(undefined)),
          (summary) => (summary?.number ? `${basename(repo)} #${summary.number} is still open` : undefined),
        ),
      // The old Promise.all was unbounded, so this stays unbounded.
      { concurrency: "unbounded" },
    );
    ends.push(...prs.filter((p): p is string => Boolean(p)));

    return ends;
  });

/**
 * Where the change's branch still exists once the worktrees are gone.
 *
 * wt keeps a branch that has commits nobody else has and removes one with nothing on it, which is
 * the behaviour you want and not the behaviour you would guess: worth reporting rather than
 * claiming either way.
 */
const keptBranchesEffect = (change: Change): Effect.Effect<string[]> =>
  Effect.map(
    Effect.forEach(
      change.repos,
      (repo) =>
        Effect.map(
          shSoft(["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`], repo),
          (exists) => (exists.code === 0 ? repo : undefined),
        ),
      // The old Promise.all was unbounded, so this stays unbounded.
      { concurrency: "unbounded" },
    ),
    (found) => found.filter((r): r is string => Boolean(r)),
  );
