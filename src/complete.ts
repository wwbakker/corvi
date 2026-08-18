import type { Change } from "./types.ts";
import type { MergeReadiness } from "./integrations/github.ts";
import { mergeReadiness, mergePr } from "./integrations/github.ts";
import { removeWorktree, unsafeToRemove } from "./integrations/git.ts";
import { moveIssue } from "./integrations/jira.ts";
import { archiveChange, writeChange } from "./changes.ts";
import { config } from "./config.ts";

export type Completion = {
  /** Every repository is either merged already or has an approved pull request. */
  ready: boolean;
  /** Why not, one line per repository that blocks completion. */
  reasons: string[];
  /** Pull requests still to merge, empty when everything was merged by hand. */
  toMerge: { repo: string; number: number }[];
};

/** Turn per-repository readiness into one verdict: a change completes as a whole or not at all. */
export function verdict(
  results: { repo: string; readiness: MergeReadiness; unsafe?: { text: string } }[],
): Completion {
  const reasons = results.flatMap(({ repo, readiness, unsafe }) => [
    ...(readiness.ready ? [] : [readiness.reason]),
    // Completing removes worktrees, so anything the remote never saw would be lost.
    ...(unsafe ? [`${repo.split("/").pop()}: ${unsafe.text}`] : []),
  ]);
  const toMerge = results.flatMap(({ repo, readiness }) =>
    readiness.ready && !readiness.merged ? [{ repo, number: readiness.number }] : [],
  );
  return { ready: reasons.length === 0, reasons, toMerge };
}

export async function completionOf(change: Change): Promise<Completion> {
  const results = await Promise.all(
    change.repos.map(async (repo) => ({
      repo,
      readiness: await mergeReadiness(change, repo),
      unsafe: await unsafeToRemove(change, repo),
    })),
  );
  return verdict(results);
}

/**
 * Merge every outstanding pull request and close the ticket. Refuses unless all repositories are
 * approved or already merged, so a change never lands half-way across repositories.
 */
export async function completeChange(change: Change): Promise<Change> {
  const completion = await completionOf(change);
  if (!completion.ready) throw new Error(`cannot complete: ${completion.reasons.join("; ")}`);

  // Sequential on purpose: if a merge fails, the ones after it should not have happened either.
  for (const { repo, number } of completion.toMerge) await mergePr(change, repo, number);
  if (change.jira) await moveIssue(change.jira, config.jiraDoneTransition);

  // The work is on the remote now, so the worktrees have nothing left to hold.
  for (const repo of change.repos) await removeWorktree(change, repo);

  const completed: Change = { ...change, completedAt: new Date().toISOString() };
  await writeChange(completed);
  await archiveChange(change.id);
  return completed;
}
