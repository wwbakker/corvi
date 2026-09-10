import { basename } from "node:path";
import { Effect, Either } from "effect";
import type { Change, CompletionProgress, CompletionStep } from "./types.ts";
import type { MergeReadiness } from "./integrations/github.ts";
import { mergeReadinessEffect, mergePrEffect } from "./integrations/github.ts";
import { removeWorktreeEffect, unsafeToRemoveEffect } from "./integrations/git.ts";
import {
  archiveChangeEffect,
  readSidecarEffect,
  writeChangeEffect,
  writeSidecarEffect,
} from "./changes.ts";
import { stopTerminalEffect } from "./terminal.ts";
import { config } from "./config.ts";
import { completionStepsFor } from "./extensions/index.ts";
import { capabilitiesLayer } from "./extensions/services.ts";
import { workspaceOf } from "./workspaces.ts";
import { BadRequestError, type CliError } from "./effect/errors.ts";
import { messageOf } from "./effect/support.ts";

export type Completion = {
  /** Every repository is either merged already or has an approved pull request. */
  ready: boolean;
  /** Why not, one line per repository that blocks completion. */
  reasons: string[];
  /** Pull requests still to merge, empty when everything was merged by hand. */
  toMerge: { repo: string; number: number }[];
};

/** Turn per-repository readiness into one verdict: a change completes as a whole or not at all. */
// Pure and synchronous: nothing for an Effect to wrap.
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

/** One repository's readiness, checked live: the two lookups per repository were sequential
 * within the repository and parallel across repositories, and stay that way. */
const completionOfRepo = (change: Change, repo: string) =>
  Effect.gen(function* () {
    return {
      repo,
      readiness: yield* mergeReadinessEffect(change, repo),
      unsafe: yield* unsafeToRemoveEffect(change, repo),
    };
  });

export const completionOfEffect = (change: Change): Effect.Effect<Completion, CliError | BadRequestError> =>
  Effect.map(
    Effect.forEach(change.repos, (repo) => completionOfRepo(change, repo), {
      // The old Promise.all was unbounded, so this stays unbounded.
      concurrency: "unbounded",
    }),
    verdict,
  );

const PROGRESS = "completion.json";

/** How far a completion got, or nothing if the change was never completed. */
export const progressOfEffect = (id: string): Effect.Effect<CompletionProgress | null> =>
  Effect.gen(function* () {
    const text = yield* readSidecarEffect(id, PROGRESS);
    try {
      return text ? (JSON.parse(text) as CompletionProgress) : null;
    } catch {
      // A half-written record reads as no record: it is our own file, and the completion that
      // was interrupted will rewrite it from where it got to.
      return null;
    }
  });

/** The completion journal: written as it happens, so a page opened later reads where a stopped
 * completion stopped. */
const save = (id: string, progress: CompletionProgress): Effect.Effect<void, BadRequestError> =>
  Effect.map(writeSidecarEffect(id, PROGRESS, JSON.stringify(progress, null, 2) + "\n"), () =>
    undefined);

/** The work a completion is about to do, named before it starts so the page can show what is
 * still coming rather than only what has happened. The extensions' steps sit between the merges
 * and the worktrees: a ticket is closed while the worktrees still exist to inspect, and no
 * directory has moved yet. */
// Pure and synchronous: nothing for an Effect to wrap.
export function stepsFor(
  change: Change,
  completion: Completion,
  contributed: CompletionStep[] = plannedContributions(change),
): CompletionStep[] {
  return [
    ...completion.toMerge.map(({ repo, number }) => ({
      id: `merge:${repo}`,
      label: `merge ${basename(repo)} #${number}`,
      state: "waiting" as const,
    })),
    ...contributed,
    { id: "worktrees", label: "remove the worktrees", state: "waiting" as const },
    { id: "terminal", label: "close the terminal", state: "waiting" as const },
    { id: "archive", label: "archive the change", state: "waiting" as const },
  ];
}

/** What this change's extensions plan to do, planned once and passed around: a plan that could
 * answer differently twice would be two promises about one completion. Pure functions get
 * plain data, so the plan reads the config and the workspace as arguments. */
const plannedContributions = (change: Change): CompletionStep[] =>
  completionStepsFor(workspaceOf(change))
    .map((contributor) =>
      contributor.plan(change, { config, workspace: workspaceOf(change) }))
    .filter((s): s is CompletionStep => Boolean(s));

/**
 * Merge every outstanding pull request and close the ticket. Refuses unless all repositories are
 * approved or already merged, so a change never lands half-way across repositories.
 *
 * Every step is written to disk as it starts and as it finishes, so a completion that stops half
 * way says where it stopped — to a page opened afterwards, or after a restart. Running it again
 * picks up what is left: merges already done are no longer outstanding.
 */
export const completeChangeEffect = (
  change: Change,
): Effect.Effect<{ change: Change; notes: string[] }, CliError | BadRequestError> =>
  Effect.gen(function* () {
    // Written before the checking starts, which is itself slow: a page that just asked for this
    // should see something immediately, and this is also the record that a completion is running.
    const progress: CompletionProgress = {
      startedAt: new Date().toISOString(),
      steps: [{ id: "check", label: "check every pull request is ready", state: "running" }],
    };
    yield* save(change.id, progress);

    const completion = yield* completionOfEffect(change);
    const checked = progress.steps[0]!;
    if (!completion.ready) {
      checked.state = "failed";
      checked.detail = completion.reasons.join("; ");
      progress.error = `cannot complete: ${completion.reasons.join("; ")}`;
      progress.finishedAt = new Date().toISOString();
      yield* save(change.id, progress);
      return yield* Effect.fail(new BadRequestError({ message: progress.error }));
    }
    checked.state = "done";
    // The extensions' steps, planned once: named in the journal before anything runs, and run
    // from that plan so it cannot promise one thing and do another.
    const workspace = workspaceOf(change);
    const capabilities = capabilitiesLayer(workspace);
    const contributions = completionStepsFor(workspace)
      .map((contributor) => ({ contributor, planned: contributor.plan(change, { config, workspace }) }))
      .filter((c): c is { contributor: typeof c.contributor; planned: CompletionStep } =>
        Boolean(c.planned));
    progress.steps = [checked, ...stepsFor(change, completion, contributions.map((c) => c.planned))];
    yield* save(change.id, progress);

    const notes: string[] = [];

    /** Run one step, recording it before and after. A failure stops the completion where it is. */
    const step = (
      id: string,
      work: Effect.Effect<string | undefined, CliError | BadRequestError>,
    ): Effect.Effect<void, CliError | BadRequestError> =>
      Effect.gen(function* () {
        const found = progress.steps.find((s) => s.id === id);
        if (!found) return;
        found.state = "running";
        yield* save(change.id, progress);
        const outcome = yield* Effect.either(work);
        if (Either.isLeft(outcome)) {
          found.state = "failed";
          found.detail = messageOf(outcome.left);
          progress.error = found.detail;
          progress.finishedAt = new Date().toISOString();
          yield* save(change.id, progress);
          return yield* Effect.fail(outcome.left);
        }
        found.detail = outcome.right;
        found.state = "done";
        yield* save(change.id, progress);
      });

    // Sequential on purpose: if a merge fails, the ones after it should not have happened either.
    // A merge that was queued rather than done is worth saying out loud: the change is finished
    // here, but the commit is not on main yet.
    for (const { repo, number } of completion.toMerge) {
      yield* step(
        `merge:${repo}`,
        Effect.tap(mergePrEffect(change, repo, number), (note) =>
          Effect.sync(() => {
            if (note) notes.push(note);
          }),
        ),
      );
    }
    // The extensions' steps: close the ticket, comment on the issue, whatever each one planned
    // for a finished change. A failure stops the completion where it stands, like any core step.
    for (const { contributor, planned } of contributions) {
      yield* step(
        planned.id,
        Effect.map(
          Effect.catchAll(
            contributor.run(change).pipe(Effect.provide(capabilities)),
            (e) => new BadRequestError({ message: messageOf(e) }),
          ),
          (note) => (typeof note === "string" ? note : undefined),
        ),
      );
    }

    // The work is on the remote now, so the worktrees have nothing left to hold.
    yield* step(
      "worktrees",
      Effect.map(
        Effect.forEach(change.repos, (repo) => removeWorktreeEffect(change, repo), {
          concurrency: 1,
          discard: true,
        }),
        () => undefined,
      ),
    );
    // The terminal sits in a directory that is about to move into the archive.
    yield* step(
      "terminal",
      Effect.map(stopTerminalEffect(change.id), () => undefined),
    );

    const completed: Change = { ...change, state: "Completed", completedAt: new Date().toISOString() };
    yield* step(
      "archive",
      Effect.map(
      Effect.gen(function* () {
        yield* writeChangeEffect(completed);
        yield* archiveChangeEffect(change.id);
      }),
      () => undefined,
      ),
    );

    progress.finishedAt = new Date().toISOString();
    yield* save(change.id, progress);
    return { change: completed, notes };
  });
