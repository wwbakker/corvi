import { basename } from "node:path";
import { Effect, Either } from "effect";
import type { Change, CompletionProgress, CompletionStep } from "./types.ts";
import type { MergeReadiness } from "./integrations/github.ts";
import { mergeReadinessEffect, mergePrEffect } from "./integrations/github.ts";
import { removeWorktreeEffect, unsafeToRemoveEffect } from "./integrations/git.ts";
import { moveIssueEffect } from "./integrations/jira.ts";
import { archiveChange, writeChange, readSidecar, writeSidecar } from "./changes.ts";
import { stopTerminal } from "./terminal.ts";
import { config } from "./config.ts";
import { BadRequestError, type CliError } from "./effect/errors.ts";

export type Completion = {
  /** Every repository is either merged already or has an approved pull request. */
  ready: boolean;
  /** Why not, one line per repository that blocks completion. */
  reasons: string[];
  /** Pull requests still to merge, empty when everything was merged by hand. */
  toMerge: { repo: string; number: number }[];
};

/** Turn per-repository readiness into one verdict: a change completes as a whole or not at all. */
// TODO-MIGRATE — pure and synchronous: nothing for an Effect to wrap.
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

/** TODO-MIGRATE — Promise facade over completionOfEffect. */
export const completionOf = (change: Change): Promise<Completion> =>
  Effect.runPromise(completionOfEffect(change));

const PROGRESS = "completion.json";

/** A failure's message, exactly as the old `e instanceof Error ? e.message : String(e)` read it:
 * every typed error carries the sentence users saw before. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How far a completion got, or nothing if the change was never completed. */
export const progressOfEffect = (id: string): Effect.Effect<CompletionProgress | null> =>
  Effect.gen(function* () {
    // TODO-MIGRATE — src/changes.ts is another worker's file; the server task sweeps this call site.
    const text = yield* Effect.tryPromise({ try: () => readSidecar(id, PROGRESS), catch: (e) => e })
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    try {
      return text ? (JSON.parse(text) as CompletionProgress) : null;
    } catch {
      // A half-written record reads as no record: it is our own file, and the completion that
      // was interrupted will rewrite it from where it got to.
      return null;
    }
  });

/** TODO-MIGRATE — Promise facade over progressOfEffect. */
export const progressOf = (id: string): Promise<CompletionProgress | null> =>
  Effect.runPromise(progressOfEffect(id));

/** The completion journal: written as it happens, so a page opened later reads where a stopped
 * completion stopped. */
// TODO-MIGRATE — src/changes.ts is another worker's file; the server task sweeps this call site.
const save = (id: string, progress: CompletionProgress): Effect.Effect<void, BadRequestError> =>
  Effect.tryPromise({
    try: () => writeSidecar(id, PROGRESS, JSON.stringify(progress, null, 2) + "\n"),
    catch: (e) => new BadRequestError({ message: messageOf(e) }),
  });

/** The work a completion is about to do, named before it starts so the page can show what is
 * still coming rather than only what has happened. */
// TODO-MIGRATE — pure and synchronous: nothing for an Effect to wrap.
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
    progress.steps = [checked, ...stepsFor(change, completion)];
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
    if (change.jira) {
      yield* step(
        "jira",
        Effect.map(moveIssueEffect(change.jira, config.jiraDoneTransition), () => undefined),
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
      Effect.map(
        // TODO-MIGRATE — src/terminal.ts is another worker's file; the server task sweeps this call site.
        Effect.tryPromise({
          try: () => stopTerminal(change.id),
          catch: (e) => new BadRequestError({ message: messageOf(e) }),
        }),
        () => undefined,
      ),
    );

    const completed: Change = { ...change, state: "Completed", completedAt: new Date().toISOString() };
    yield* step(
      "archive",
      Effect.map(
      Effect.gen(function* () {
        // TODO-MIGRATE — src/changes.ts is another worker's file; the server task sweeps this call site.
        yield* Effect.tryPromise({
          try: () => writeChange(completed),
          catch: (e) => new BadRequestError({ message: messageOf(e) }),
        });
        // TODO-MIGRATE — src/changes.ts is another worker's file; the server task sweeps this call site.
        yield* Effect.tryPromise({
          try: () => archiveChange(change.id),
          catch: (e) => new BadRequestError({ message: messageOf(e) }),
        });
      }),
      () => undefined,
      ),
    );

    progress.finishedAt = new Date().toISOString();
    yield* save(change.id, progress);
    return { change: completed, notes };
  });

/** TODO-MIGRATE — Promise facade over completeChangeEffect. */
export const completeChange = (
  change: Change,
): Promise<{ change: Change; notes: string[] }> => Effect.runPromise(completeChangeEffect(change));
