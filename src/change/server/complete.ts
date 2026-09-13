import { basename } from "node:path";
import { Effect, Either } from "effect";
import type { Change, CompletionProgress, CompletionStep } from "../../domain/change.ts";
import { isIdeation } from "../../domain/change.ts";
import type { MergeReadiness } from "../../vendors/github.ts";
import { mergeReadiness, mergePr } from "../../vendors/github.ts";
import type { Changes } from "../../extension-host/api/capabilities.ts";
import { removeWorktree, unsafeToRemove, type Unsafe } from "../../vendors/git.ts";
import {
  archiveChange,
  changeDir,
  readSidecar,
  writeChange,
  writeSidecar,
} from "./store.ts";
import { stopTerminal } from "../../terminals/server/index.ts";
import { config } from "../../workspace/server/index.ts";
import {
  afterChange,
  beforeChange,
  completionStepsFor,
  type ProvisionResult,
} from "../../extension-host/index.ts";
import { capabilitiesLayer } from "../../extension-host/services.ts";
import { workspaceOf } from "../../workspace/server/index.ts";
import {
  BadRequestError,
  DecodeError,
  type CliError,
  type IweError,
} from "../../capabilities/effect/errors.ts";
import { messageOf } from "../../capabilities/effect/support.ts";

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

/** One repository's readiness, checked live: the two lookups per repository run sequentially,
 * and the repositories in parallel. */
const completionOfRepo = (
  change: Change,
  repo: string,
): Effect.Effect<{ repo: string; readiness: MergeReadiness; unsafe: Unsafe | undefined }, BadRequestError, Changes> =>
  Effect.gen(function* () {
    return {
      repo,
      readiness: yield* mergeReadiness(change, repo),
      unsafe: yield* unsafeToRemove(change, repo),
    };
  });

export const completionOf = (change: Change): Effect.Effect<Completion, CliError | BadRequestError, Changes> =>
  // An idea has nothing to complete: no pull requests, no checkouts. Answered without the CLI
  // lookups, which would find nothing and cost a call per repository.
  isIdeation(change)
    ? Effect.succeed({
        ready: false,
        reasons: ["still an idea: start the work before completing it"],
        toMerge: [],
      })
    : Effect.map(
        Effect.forEach(change.repos, (repo) => completionOfRepo(change, repo), {
          // Unbounded concurrency is deliberate: these per-repo lookups are independent.
          concurrency: "unbounded",
        }),
        verdict,
      );

const PROGRESS = "completion.json";

/** How far a completion got, or nothing if the change was never completed. */
export const progressOf = (id: string): Effect.Effect<CompletionProgress | null> =>
  Effect.gen(function* () {
    const text = yield* readSidecar(id, PROGRESS);
    if (!text) return null;
    // A half-written record reads as no record: it is our own file, and the completion that
    // was interrupted will rewrite it from where it got to.
    return yield* Effect.try({
      try: () => JSON.parse(text) as CompletionProgress,
      catch: (e) => new DecodeError({ source: "file", message: messageOf(e) }),
    }).pipe(Effect.orElseSucceed(() => null));
  });

/** The completion journal: written as it happens, so a page opened later reads where a stopped
 * completion stopped. */
const save = (id: string, progress: CompletionProgress): Effect.Effect<void, BadRequestError> =>
  Effect.map(writeSidecar(id, PROGRESS, JSON.stringify(progress, null, 2) + "\n"), () =>
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
    .map(({ contribution }) =>
      contribution.plan(change, { config, workspace: workspaceOf(change) }))
    .filter((s): s is CompletionStep => Boolean(s));

/**
 * Merge every outstanding pull request and close the ticket. Refuses unless all repositories are
 * approved or already merged, so a change never lands half-way across repositories.
 *
 * Every step is written to disk as it starts and as it finishes, so a completion that stops half
 * way says where it stopped — to a page opened afterwards, or after a restart. Running it again
 * picks up what is left: merges already done are skipped.
 */
export const completeChange = (
  change: Change,
): Effect.Effect<{ change: Change; notes: string[]; after: ProvisionResult[] }, IweError, Changes> =>
  Effect.gen(function* () {
    // The one transition out of `Ideation` is starting the work; completing an idea would archive
    // it as landed with no checkouts and no ticket moved. Refused before anything is written.
    if (isIdeation(change)) {
      return yield* new BadRequestError({
        message: `${change.id} is still an idea: start the work before completing it`,
      });
    }
    // Written before the checking starts, which is itself slow: a page that just asked for this
    // should see something immediately, and this is also the record that a completion is running.
    const progress: CompletionProgress = {
      startedAt: new Date().toISOString(),
      steps: [{ id: "check", label: "check every pull request is ready", state: "running" }],
    };
    yield* save(change.id, progress);

    const completion = yield* completionOf(change);
    const checked = progress.steps[0]!;
    if (!completion.ready) {
      checked.state = "failed";
      checked.detail = completion.reasons.join("; ");
      progress.error = `cannot complete: ${completion.reasons.join("; ")}`;
      progress.finishedAt = new Date().toISOString();
      yield* save(change.id, progress);
      return yield* new BadRequestError({ message: progress.error });
    }
    // The before-hooks run now, with readiness proven and nothing irreversible done: a veto here
    // leaves the change exactly as it was. These see the change, not a draft — there is nothing
    // to patch about a completion — so their only move is to fail. The journal records the veto
    // rather than leaving a completion looking like it is still checking.
    const vetoed = yield* Effect.either(beforeChange("change:completing", change));
    if (Either.isLeft(vetoed)) {
      checked.state = "failed";
      checked.detail = messageOf(vetoed.left);
      progress.error = messageOf(vetoed.left);
      progress.finishedAt = new Date().toISOString();
      yield* save(change.id, progress);
      return yield* vetoed.left;
    }
    checked.state = "done";
    // The extensions' steps, planned once: named in the journal before anything runs, and run
    // from that plan so it cannot promise one thing and do another.
    const workspace = workspaceOf(change);
    const contributions = completionStepsFor(workspace)
      .map(({ name, contribution }) => ({
        name,
        contributor: contribution,
        planned: contribution.plan(change, { config, workspace }),
      }))
      .filter((c): c is { name: string; contributor: typeof c.contributor; planned: CompletionStep } =>
        Boolean(c.planned));
    progress.steps = [checked, ...stepsFor(change, completion, contributions.map((c) => c.planned))];
    yield* save(change.id, progress);

    const notes: string[] = [];

    /** Run one step, recording it before and after. A failure stops the completion where it is. */
    const step = (
      id: string,
      work: Effect.Effect<string | undefined, CliError | BadRequestError, Changes>,
    ): Effect.Effect<void, CliError | BadRequestError, Changes> =>
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
          return yield* outcome.left;
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
        Effect.tap(mergePr(change, repo, number), (note) =>
          Effect.sync(() => {
            if (note) notes.push(note);
          }),
        ),
      );
    }
    // The extensions' steps: close the ticket, comment on the issue, whatever each one planned
    // for a finished change. A failure stops the completion where it stands, like any core step.
    for (const { name, contributor, planned } of contributions) {
      yield* step(
        planned.id,
        Effect.map(
          Effect.catchAll(
            contributor.run(change).pipe(Effect.provide(capabilitiesLayer(workspace, name))),
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
        Effect.forEach(change.repos, (repo) => removeWorktree(change, repo), {
          concurrency: 1,
          discard: true,
        }),
        () => undefined,
      ),
    );
    // The terminal sits in a directory that is about to move into the archive.
    yield* step(
      "terminal",
      Effect.map(stopTerminal(change.id, changeDir(change.id)), () => undefined),
    );

    const completed: Change = { ...change, state: "Completed", completedAt: new Date().toISOString() };
    yield* step(
      "archive",
      Effect.map(
      Effect.gen(function* () {
        yield* writeChange(completed);
        yield* archiveChange(change.id);
      }),
      () => undefined,
      ),
    );

    progress.finishedAt = new Date().toISOString();
    yield* save(change.id, progress);
    // The after-hooks observe a change that is already committed and archived. Their failures are
    // reported under each extension's name and never fail the completion.
    const after = yield* afterChange("change:completed", completed);
    return { change: completed, notes, after };
  });
