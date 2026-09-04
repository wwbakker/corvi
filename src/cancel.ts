import { basename } from "node:path";
import type { Change } from "./types.ts";
import { removeWorktree, unsafeToRemove } from "./integrations/git.ts";
import { prSummary } from "./integrations/github.ts";
import { archiveChange, writeChange } from "./changes.ts";
import { stopTerminal } from "./terminal.ts";
import { sh } from "./sh.ts";

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

/** Names of the repositories whose work would be lost, when that needs asking about first. */
export type NeedsForce = { needsForce: string[] };

export async function cancelChange(
  change: Change,
  force = false,
): Promise<Cancellation | NeedsForce> {
  const unsafe = await Promise.all(
    change.repos.map(async (repo) => ({ repo, unsafe: await unsafeToRemove(change, repo) })),
  );

  // Uncommitted work cannot be recovered from anywhere, so it is never thrown away on the
  // strength of a menu item: commit it, or revert it, and then cancel.
  const dirty = unsafe.filter((u) => u.unsafe?.kind === "dirty");
  if (dirty.length) {
    throw new Error(
      `${dirty.map((d) => basename(d.repo)).join(", ")}: uncommitted changes, ` +
        `commit or revert them before cancelling`,
    );
  }
  // Commits nobody else has: the branch survives a cancellation, so these are recoverable — but
  // only by someone who knows the branch is there, which is worth one question.
  const unpushed = unsafe.filter((u) => u.unsafe?.kind === "unpushed");
  if (unpushed.length && !force) return { needsForce: unpushed.map((u) => basename(u.repo)) };

  // Asked before the worktrees go, because that is where the pull request is looked up from.
  const loose = await looseEnds(change);

  for (const repo of change.repos) await removeWorktree(change, repo);
  await stopTerminal(change.id);

  // Asked afterwards, because it is a fact about what is left: wt keeps a branch that has commits
  // nobody has seen and removes one that has nothing on it, and only the first is a loose end.
  const kept = await keptBranches(change);
  if (kept.length) {
    loose.push(`the branch ${change.branch} is kept in ${kept.map((repo) => basename(repo)).join(", ")}`);
  }

  const cancelled: Change = {
    ...change,
    state: "Cancelled",
    completedAt: new Date().toISOString(),
  };
  await writeChange(cancelled);
  await archiveChange(change.id);
  return { change: cancelled, loose };
}

/**
 * What cancelling deliberately leaves alone, said out loud.
 *
 * A cancelled change that quietly leaves an open pull request and a ticket in progress is a
 * change that comes back to you in a week as somebody else's question.
 */
async function looseEnds(change: Change): Promise<string[]> {
  const ends: string[] = [];
  if (change.jira) ends.push(`${change.jira} is still open in Jira`);

  const prs = await Promise.all(
    change.repos.map(async (repo) => {
      // Best effort: a repository with no pull request, or no network, is not a loose end worth
      // failing a cancellation over.
      const summary = await prSummary(change, repo).catch(() => undefined);
      return summary?.number ? `${basename(repo)} #${summary.number} is still open` : undefined;
    }),
  );
  ends.push(...prs.filter((p): p is string => Boolean(p)));

  return ends;
}

/**
 * Where the change's branch still exists once the worktrees are gone.
 *
 * wt keeps a branch that has commits nobody else has and removes one with nothing on it, which is
 * the behaviour you want and not the behaviour you would guess: worth reporting rather than
 * claiming either way.
 */
async function keptBranches(change: Change): Promise<string[]> {
  const found = await Promise.all(
    change.repos.map(async (repo) => {
      const exists = await sh(
        ["git", "show-ref", "--verify", "--quiet", `refs/heads/${change.branch}`],
        repo,
      );
      return exists.code === 0 ? repo : undefined;
    }),
  );
  return found.filter((r): r is string => Boolean(r));
}
