import { Effect, Either, Layer, Ref } from "effect";
import type {
  Change,
  Completion,
  CompletionProgress,
  CompletionReason,
  CompletionRefusal,
} from "../../domain/change.ts";
import { isIdeation } from "../../domain/change.ts";
import type { MergeReadiness } from "@corvi/github/client";
import { mergeReadiness, refreshReadiness, forgetPrs } from "@corvi/github/client";
import type { Cache, GitFacts } from "@corvi/contracts/capabilities";
import type { Changes } from "../../integrations/api/capabilities.ts";
import { unsafeToRemove, type Unsafe } from "../../vendors/git.ts";
import { archiveRoot, readChange, readSidecar, root, writeSidecar } from "./store.ts";
import { workspaceOf } from "../../workspace/server/index.ts";
import { ChangeRepositories } from "@corvi/changes/repositories";
import { ChangeStoreError } from "@corvi/changes/errors";
import { layer as changesNodeLayer, storeLayer } from "@corvi/changes/node";
import { OperationProgress } from "@corvi/changes/progress";
import { ChangeId, type Repository } from "@corvi/contracts/changes";
import {
  ChangeLifecycle,
  type Acknowledgement,
  type LifecycleOutcome,
  type LifecycleReason,
  type OutstandingPullRequest,
} from "@corvi/workflows/lifecycle";
import {
  BadRequestError,
  DecodeError,
  InternalError,
  NotFoundError,
  isIweError,
  type CliError,
  type IweError,
} from "@corvi/contracts/errors";
import { messageOf } from "../../capabilities/effect/support.ts";
import { lifecycleLayer } from "../lifecycle-layer.ts";

// The page reads the same completion types; they live in the domain so both halves agree.
export type { Completion, CompletionReason, CompletionRefusal };

/** What a completion request produced: it ran to the end, or it was not ready and the page must
 * acknowledge why first. An unmet hard reason (an idea, uncommitted work) is neither — it fails,
 * because no acknowledgement can make it go away. */
export type CompletionResult =
  | { _tag: "Done"; change: Change; notes: string[] }
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
): Effect.Effect<{ repo: string; readiness: MergeReadiness; unsafe: Unsafe | undefined }, BadRequestError, Changes | GitFacts | Cache> =>
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
): Effect.Effect<Completion, CliError | BadRequestError, Changes | GitFacts | Cache> =>
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

/** The completion journal while the workflow runs: the page polls `completion.json`, so this
 * adapter keeps writing that shape from the workflow's steps. */
const completionProgressLayer = (
  changeId: string,
  ref: Ref.Ref<CompletionProgress>,
): Layer.Layer<OperationProgress> =>
  Layer.succeed(OperationProgress, {
    record: ({ step }) =>
      Effect.gen(function* () {
        yield* Ref.update(ref, (progress): CompletionProgress => {
          const index = progress.steps.findIndex((existing) => existing.id === step.id)
          const steps = [...progress.steps]
          const existing = steps[index]
          if (existing !== undefined)
            steps[index] = {
              ...existing,
              state: step.state,
              ...(step.detail ? { detail: step.detail } : {}),
            }
          else
            steps.push({
              id: step.id,
              label: step.label,
              state: step.state,
              ...(step.detail ? { detail: step.detail } : {}),
            })
          return { ...progress, steps }
        })
        yield* writeProgress(changeId, ref)
      }),
  })

const writeProgress = (
  changeId: string,
  ref: Ref.Ref<CompletionProgress>,
): Effect.Effect<void, ChangeStoreError> =>
  Effect.flatMap(Ref.get(ref), (progress) =>
    save(changeId, progress).pipe(
      Effect.mapError(
        (error) =>
          new ChangeStoreError({
            changeId: ChangeId.make(changeId),
            operation: "write",
            message: error.message,
            cause: error,
          }),
      ),
    ),
  )

const finalizeProgress = (
  changeId: string,
  ref: Ref.Ref<CompletionProgress>,
  error?: string,
): Effect.Effect<void, ChangeStoreError> =>
  Effect.gen(function* () {
    yield* Ref.update(ref, (progress): CompletionProgress => ({
      ...progress,
      finishedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    }))
    yield* writeProgress(changeId, ref)
  })

const toLegacyReasons = (reasons: readonly LifecycleReason[]): CompletionReason[] =>
  reasons.map((reason) => ({ text: reason.text, kind: reason.kind }))

const toLegacyToMerge = (
  links: readonly Repository[],
  outstanding: readonly OutstandingPullRequest[],
): Completion["toMerge"] =>
  outstanding.flatMap((pullRequest) => {
    const link = links.find(
      (entry) => entry.repositoryId === pullRequest.repository.repositoryId,
    )
    return link ? [{ repo: link.originalLocation, number: pullRequest.number }] : []
  })

const isAcknowledgementCode = (
  code: LifecycleReason["code"],
): code is Acknowledgement["code"] =>
  code === "review-pending" ||
  code === "unpushed" ||
  code === "ownership-unverified" ||
  code === "shared-worktree" ||
  code === "provider-veto"

const acknowledgementsFor = (reasons: readonly LifecycleReason[]): readonly Acknowledgement[] =>
  reasons.flatMap((reason) =>
    reason.kind === "forceable" && isAcknowledgementCode(reason.code)
      ? [{ code: reason.code, subject: reason.subject, facts: reason.facts }]
      : [],
  )

const errorDetail = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)

/** The transport boundary for this operation: capability failures become the taxonomy the route
 * mapper knows; the workflow and capability errors stay typed behind it. */
const asIwe = (error: unknown): IweError => {
  if (isIweError(error)) return error
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag)
    const raw = "message" in error ? (error as { message: unknown }).message : undefined
    const message = raw ? String(raw) : tag
    return tag === "ChangeNotFound"
      ? new NotFoundError({ message })
      : new BadRequestError({ message })
  }
  return new BadRequestError({ message: messageOf(error) })
}

/**
 * Merge every outstanding pull request and close the ticket, through the lifecycle workflow.
 * Readiness is checked fresh inside the workflow; the app adapter keeps the old protocol: a
 * change that is not ready comes back as `NotReady` for the page to acknowledge (`force` waives
 * every forceable reason after the page made each one explicit), a hard reason fails even with
 * force, and the extension veto runs before anything irreversible.
 *
 * The `completion.json` journal is written as each workflow step runs, so a completion that stops
 * half way says where it stopped — to a page opened afterwards, or after a restart.
 */
export const completeChange = (
  change: Change,
  force = false,
): Effect.Effect<CompletionResult, IweError, Changes> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<CompletionProgress>({
      startedAt: new Date().toISOString(),
      ...(force ? { forced: true as const } : {}),
      steps: [],
    })
    const workspace = workspaceOf(change)
    const roots = { root: root(), archiveRoot: archiveRoot() }
    const layer = Layer.merge(
      lifecycleLayer(workspace, roots, {
        progress: completionProgressLayer(change.id, ref),
      }),
      changesNodeLayer.pipe(Layer.provide(storeLayer(roots))),
    )
    return yield* runCompletion(change, ref, force).pipe(Effect.provide(layer))
  })

const runCompletion = (
  change: Change,
  ref: Ref.Ref<CompletionProgress>,
  force: boolean,
): Effect.Effect<CompletionResult, IweError, ChangeLifecycle | ChangeRepositories> =>
  Effect.gen(function* () {
    const changeId = ChangeId.make(change.id)
    const lifecycle = yield* ChangeLifecycle
    const repositoryLinks = yield* ChangeRepositories
    const links = yield* repositoryLinks
      .listRepositories(changeId)
      .pipe(Effect.mapError((error) => new BadRequestError({ message: error.message })))

    // Fresh, and before anything is written: a refusal is a dialog, not a completion that
    // started and stopped. The same assessment is handed to the workflow, so the click path
    // pays for one readiness check, not two.
    const assessment = yield* lifecycle.assessCompletion(changeId, { fresh: true })
    if (assessment._tag === "Blocked" && !force)
      return {
        _tag: "NotReady" as const,
        refusal: {
          reasons: toLegacyReasons(assessment.reasons),
          toMerge: toLegacyToMerge(links, assessment.toMerge),
        },
      }
    if (assessment._tag === "Blocked")
      return yield* new BadRequestError({
        message: `cannot complete: ${assessment.reasons.map((reason) => reason.text).join("; ")}`,
      })
    if (assessment._tag === "AcknowledgementRequired" && !force)
      return {
        _tag: "NotReady" as const,
        refusal: {
          reasons: toLegacyReasons(assessment.reasons),
          toMerge: toLegacyToMerge(links, assessment.toMerge),
        },
      }

    const overridden =
      assessment._tag === "AcknowledgementRequired"
        ? assessment.reasons
            .filter((reason) => reason.kind === "forceable")
            .map((reason) => reason.text)
        : []
    yield* Ref.update(ref, (progress): CompletionProgress => ({
      ...progress,
      ...(overridden.length > 0 ? { overridden } : {}),
      steps: [{ id: "check", label: "check every repository is ready", state: "running" as const }],
    }))
    yield* writeProgress(change.id, ref)

    const run = (
      acknowledgements: readonly Acknowledgement[],
    ): Effect.Effect<LifecycleOutcome, IweError | ChangeStoreError> =>
      lifecycle.completeChange({ changeId, acknowledgements, assessment }).pipe(
        Effect.catchAll((error): Effect.Effect<never, IweError | ChangeStoreError, never> =>
          Effect.gen(function* () {
            yield* finalizeProgress(change.id, ref, errorDetail(error))
            return yield* Effect.fail(asIwe(error))
          }),
        ),
      )

    const outcome = yield* run(
      acknowledgementsFor(assessment._tag === "Ready" ? [] : assessment.reasons),
    )

    if (outcome._tag === "Done") {
      yield* finalizeProgress(change.id, ref)
      const updated = yield* readChange(change.id)
      if (!updated)
        return yield* new InternalError({
          message: "the completed change could not be read back",
        })
      const notes = [
        ...(overridden.length > 0
          ? [`completed with overrides: ${overridden.join("; ")}`]
          : []),
        ...outcome.notes,
      ]
      return { _tag: "Done" as const, change: updated, notes }
    }
    if (outcome._tag === "NeedsAcknowledgement") {
      yield* finalizeProgress(change.id, ref)
      return {
        _tag: "NotReady" as const,
        refusal: {
          reasons: toLegacyReasons(outcome.reasons),
          toMerge: toLegacyToMerge(links, outcome.toMerge),
        },
      }
    }
    yield* finalizeProgress(
      change.id,
      ref,
      outcome.reasons.map((reason) => reason.text).join("; "),
    )
    return yield* new BadRequestError({
      message: `cannot complete: ${outcome.reasons.map((reason) => reason.text).join("; ")}`,
    })
  }).pipe(
    Effect.catchAll((error): Effect.Effect<never, IweError> => Effect.fail(asIwe(error))),
  )
