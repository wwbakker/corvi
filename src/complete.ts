import { basename } from "node:path";
import type { Change, CompletionProgress, CompletionStep } from "./types.ts";
import type { MergeReadiness } from "./integrations/github.ts";
import { mergeReadiness, mergePr } from "./integrations/github.ts";
import { removeWorktree, unsafeToRemove } from "./integrations/git.ts";
import { moveIssue } from "./integrations/jira.ts";
import { archiveChange, writeChange, readSidecar, writeSidecar } from "./changes.ts";
import { stopTerminal } from "./terminal.ts";
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

const PROGRESS = "completion.json";

/** How far a completion got, or nothing if the change was never completed. */
export async function progressOf(id: string): Promise<CompletionProgress | null> {
  const text = await readSidecar(id, PROGRESS);
  try {
    return text ? (JSON.parse(text) as CompletionProgress) : null;
  } catch {
    return null;
  }
}

const save = (id: string, progress: CompletionProgress): Promise<void> =>
  writeSidecar(id, PROGRESS, JSON.stringify(progress, null, 2) + "\n");

/** The work a completion is about to do, named before it starts so the page can show what is
 * still coming rather than only what has happened. */
export function stepsFor(change: Change, completion: Completion): CompletionStep[] {
  return [
    ...completion.toMerge.map(({ repo, number }) => ({
      id: `merge:${repo}`,
      label: `merge ${basename(repo)} #${number}`,
      state: "waiting" as const,
    })),
    ...(change.jira
      ? [{ id: "jira", label: `move ${change.jira} to ${config.jiraDoneTransition}`, state: "waiting" as const }]
      : []),
    { id: "worktrees", label: "remove the worktrees", state: "waiting" as const },
    { id: "terminal", label: "close the terminal", state: "waiting" as const },
    { id: "archive", label: "archive the change", state: "waiting" as const },
  ];
}

/**
 * Merge every outstanding pull request and close the ticket. Refuses unless all repositories are
 * approved or already merged, so a change never lands half-way across repositories.
 *
 * Every step is written to disk as it starts and as it finishes, so a completion that stops half
 * way says where it stopped — to a page opened afterwards, or after a restart. Running it again
 * picks up what is left: merges already done are no longer outstanding.
 */
export async function completeChange(change: Change): Promise<{ change: Change; notes: string[] }> {
  // Written before the checking starts, which is itself slow: a page that just asked for this
  // should see something immediately, and this is also the record that a completion is running.
  const progress: CompletionProgress = {
    startedAt: new Date().toISOString(),
    steps: [{ id: "check", label: "check every pull request is ready", state: "running" }],
  };
  await save(change.id, progress);

  const completion = await completionOf(change);
  const checked = progress.steps[0]!;
  if (!completion.ready) {
    checked.state = "failed";
    checked.detail = completion.reasons.join("; ");
    progress.error = `cannot complete: ${completion.reasons.join("; ")}`;
    progress.finishedAt = new Date().toISOString();
    await save(change.id, progress);
    throw new Error(progress.error);
  }
  checked.state = "done";
  progress.steps = [checked, ...stepsFor(change, completion)];
  await save(change.id, progress);

  const notes: string[] = [];

  /** Run one step, recording it before and after. A failure stops the completion where it is. */
  const step = async (id: string, work: () => Promise<string | undefined>): Promise<void> => {
    const found = progress.steps.find((s) => s.id === id);
    if (!found) return;
    found.state = "running";
    await save(change.id, progress);
    try {
      found.detail = await work();
      found.state = "done";
    } catch (e) {
      found.state = "failed";
      found.detail = e instanceof Error ? e.message : String(e);
      progress.error = found.detail;
      progress.finishedAt = new Date().toISOString();
      await save(change.id, progress);
      throw e;
    }
    await save(change.id, progress);
  };

  // Sequential on purpose: if a merge fails, the ones after it should not have happened either.
  // A merge that was queued rather than done is worth saying out loud: the change is finished
  // here, but the commit is not on main yet.
  for (const { repo, number } of completion.toMerge) {
    await step(`merge:${repo}`, async () => {
      const note = await mergePr(change, repo, number);
      if (note) notes.push(note);
      return note;
    });
  }
  if (change.jira) {
    await step("jira", async () => {
      await moveIssue(change.jira!, config.jiraDoneTransition);
      return undefined;
    });
  }

  // The work is on the remote now, so the worktrees have nothing left to hold.
  await step("worktrees", async () => {
    for (const repo of change.repos) await removeWorktree(change, repo);
    return undefined;
  });
  // The terminal sits in a directory that is about to move into the archive.
  await step("terminal", async () => {
    await stopTerminal(change.id);
    return undefined;
  });

  const completed: Change = { ...change, state: "Completed", completedAt: new Date().toISOString() };
  await step("archive", async () => {
    await writeChange(completed);
    await archiveChange(change.id);
    return undefined;
  });

  progress.finishedAt = new Date().toISOString();
  await save(change.id, progress);
  return { change: completed, notes };
}
