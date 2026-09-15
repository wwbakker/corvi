import { basename } from "node:path";
import { Effect, Either } from "effect";
import type {
  Change,
  Completion,
  CompletionProgress,
  CompletionReason,
  CompletionRefusal,
  CompletionStep,
} from "../../domain/change.ts";
import { isIdeation } from "../../domain/change.ts";
import type { MergeReadiness } from "../../vendors/github.ts";
import { mergeReadiness, mergePr, refreshReadiness, forgetPrs } from "../../vendors/github.ts";
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

// The page reads the same completion types; they live in the domain so both halves agree.
export type { Completion, CompletionReason, CompletionRefusal };

/** What a completion request produced: it ran to the end, or it was not ready and the page must
 * acknowledge why first. An unmet hard reason (an idea, uncommitted work) is neither — it fails,
 * because no acknowledgement can make it go away. */
export type CompletionResult =
  | { _tag: "Done"; change: Change; notes: string[]; after: ProvisionResult[] }
  | { _tag: "NotReady"; refusal: CompletionRefusal };

/** Turn per-repository readiness into one verdict: a change completes as a whole or not at all. */
// Pure and synchronous: nothing for an Effect to wrap.
export function verdict(
  results: { repo: string; readiness: MergeReadiness; unsafe?: Unsafe }[],
): Completion {
  const tagged: CompletionReason[] = results.flatMap(({ repo, readiness, unsafe }) => [
    ...(readiness.ready ? [] : [{ text: readiness.reason, kind: "forceable" as const }]),
    // Completing removes worktrees, so anything the remote never saw would be lost.
    // Unpushed commits survive on the branch and can be acknowledged away; uncommitted
    // work exists nowhere else and refuses outright, even with force.
    ...(unsafe
      ? [{
        text: `${repo.split("/").pop()}: ${unsafe.text}`,
        kind: (unsafe.kind === "dirty" ? "hard" : "forceable") as CompletionReason["kind"],
      }]
      : []),
  ]);
  const toMerge = results.flatMap(({ repo, readiness }) =>
    readiness.ready && !readiness.merged ? [{ repo, number: readiness.number }] : [],
  );
  return {
    ready: tagged.length === 0,
    reasons: tagged.map((r) => r.text),
    tagged,
    toMerge,
  };
}

/** One repository's readiness, checked live: the two lookups per repository run sequentially,
 * and the repositories in parallel. `fresh` fetches before reading, for the click path — the
 * branch may have merged upstream seconds ago, and the poll's verdict would still say
 * otherwise. */
const completionOfRepo = (
  change: Change,
  repo: string,
  fresh: boolean,
): Effect.Effect<{ repo: string; readiness: MergeReadiness; unsafe: Unsafe | undefined }, BadRequestError, Changes> =>
  Effect.gen(function* () {
    return {
      repo,
      readiness: yield* (fresh ? refreshReadiness : mergeReadiness)(change, repo),
      unsafe: yield* unsafeToRemove(change, repo),
    };
  });

export const completionOf = (
  change: Change,
  fresh = false,
): Effect.Effect<Completion, CliError | BadRequestError, Changes> =>
  // An idea has nothing to complete: no pull requests, no checkouts. Answered without the CLI
  // lookups, which would find nothing and cost a call per repository. Hard: starting the work
  // is the only way out of Ideation, and no override waives it.
  isIdeation(change)
    ? Effect.succeed({
        ready: false,
        reasons: ["still an idea: start the work before completing it"],
        tagged: [{
          text: "still an idea: start the work before completing it",
          kind: "hard" as const,
        }],
        toMerge: [],
      })
    : Effect.gen(function* () {
        // Forget the cached pull-request reads once for the change, before any repository is
        // asked: an action just made them wrong, and the dialog must not list what has already
        // resolved. Per-change, not per-repository, so a click path pays for it once.
        if (fresh) yield* forgetPrs(change);
        const results = yield* Effect.forEach(
          change.repos,
          (repo) => completionOfRepo(change, repo, fresh),
          // Unbounded concurrency is deliberate: these per-repo lookups are independent.
          { concurrency: "unbounded" },
        );
        return verdict(results);
      });

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
 * Merge every outstanding pull request and close the ticket. Checks readiness fresh first: a
 * change that is not ready comes back as `NotReady` for the page to acknowledge (`force` waives
 * every forceable reason — unmerged PRs, unpushed commits — after the page made each one
 * explicit). A hard reason — an idea, uncommitted work — fails even with force, because no
 * acknowledgement makes it go away; an extension veto is discovered after the check and likewise
 * fails. The waived reasons are journaled and reported as notes.
 *
 * Every step is written to disk as it starts and as it finishes, so a completion that stops half
 * way says where it stopped — to a page opened afterwards, or after a restart. Running it again
 * picks up what is left: merges already done are skipped.
 */
export const completeChange = (
  change: Change,
  force = false,
): Effect.Effect<CompletionResult, IweError, Changes> =>
  Effect.gen(function* () {
    // Fresh, and before anything is written: a decision about whether to start is not a completion
    // that started and stopped. `completionOf` also answers for an idea without the CLI lookups.
    const completion = yield* completionOf(change, true);
    const overridden = completion.tagged.filter((r) => r.kind === "forceable").map((r) => r.text);
    const hard = completion.tagged.filter((r) => r.kind === "hard").map((r) => r.text);
    if (!completion.ready && !force) {
      return {
        _tag: "NotReady" as const,
        refusal: { reasons: completion.tagged, toMerge: completion.toMerge },
      };
    }
    // Forced, but something no waiver reaches is unmet — an idea, uncommitted work. An error,
    // not a refusal: acknowledging reasons cannot make these go away.
    if (!completion.ready && hard.length > 0) {
      return yield* new BadRequestError({
        message: `cannot complete: ${completion.reasons.join("; ")}`,
      });
    }
    // Written now that it will run: the record that a completion is in progress. Forced from the
    // start, so a retry reads the mode from the journal rather than the request.
    const progress: CompletionProgress = {
      startedAt: new Date().toISOString(),
      ...(force ? { forced: true as const } : {}),
      steps: [{ id: "check", label: "check every pull request is ready", state: "running" }],
    };
    yield* save(change.id, progress);
    const checked = progress.steps[0]!;
    const notes: string[] =
      force && overridden.length > 0
        ? [`completed with overrides: ${overridden.join("; ")}`]
        : [];
    if (force && overridden.length > 0) {
      progress.overridden = overridden;
      checked.detail = `overridden: ${overridden.join("; ")}`;
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
      Effect.map(stopTerminal(change.id), () => undefined),
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
    return { _tag: "Done" as const, change: completed, notes, after };
  });
