/** Completion and cancellation over the capabilities.
 *
 * These are the only writers of terminal phases. An earlier assessment is never authorization:
 * every destructive step rechecks the facts it acts on, and a changed fact needs a fresh
 * acknowledgement. The journal is written step by step, so a half-finished operation stays
 * legible from a page that was never open.
 */
import { Context, Data, Effect, Layer, Ref, type Either } from "effect"

import { ChangeService } from "@corvi/changes/changes"
import { ChangeRepositories } from "@corvi/changes/repositories"
import type {
  ChangeConflict,
  ChangeNotFound,
  ChangeStoreError,
  InvalidTransition,
  RepositoryStoreError,
} from "@corvi/changes/errors"
import { OperationProgress, type OperationStep } from "@corvi/changes/progress"
import { checkoutLocationOf, isTerminal } from "@corvi/changes/rules"
import type { Change, ChangeId, Repository, RepositoryRef } from "@corvi/contracts/changes"
import { AbsolutePath } from "@corvi/contracts/paths"
import type { BranchCleanup, RemovalAssessment } from "@corvi/repositories"
import { CheckoutError, Repositories } from "@corvi/repositories"

export class ChangeOperationInProgress extends Data.TaggedError("ChangeOperationInProgress")<{
  readonly changeId: ChangeId
  /** The sentence the user sees: an error without one reaches a transport boundary as an empty
   * string, which is rendered as the error's type name instead. */
  readonly message: string
}> {}

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class TerminalError extends Data.TaggedError("TerminalError")<{
  readonly changeId: ChangeId
  readonly message: string
  readonly cause?: unknown
}> {}

export type AcknowledgementCode =
  | "review-pending"
  | "unpushed"
  | "ownership-unverified"
  | "shared-worktree"
  | "provider-veto"

export type LifecycleReasonCode = AcknowledgementCode | "idea" | "dirty-worktree" | "finished"

export type LifecycleReason = {
  readonly code: LifecycleReasonCode
  readonly subject?: RepositoryRef
  readonly kind: "forceable" | "hard"
  readonly text: string
  /** Fingerprints the observed facts: changed facts need a fresh acknowledgement. */
  readonly facts: string
}

export type Readiness =
  | { readonly _tag: "Ready"; readonly toMerge: readonly OutstandingPullRequest[] }
  | {
      readonly _tag: "AcknowledgementRequired"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }
  | {
      readonly _tag: "Blocked"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }

export type Acknowledgement = {
  readonly code: AcknowledgementCode
  readonly subject?: RepositoryRef
  readonly facts: string
}

export type LifecycleOutcome =
  | {
      readonly _tag: "Done"
      readonly change: Change
      readonly notes: readonly string[]
      readonly loose: readonly string[]
    }
  | {
      readonly _tag: "NeedsAcknowledgement"
      readonly operation: "complete" | "cancel"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }
  | {
      readonly _tag: "Blocked"
      readonly operation: "complete" | "cancel"
      readonly reasons: readonly LifecycleReason[]
      readonly toMerge: readonly OutstandingPullRequest[]
    }

export type PullRequestState = {
  readonly repository: RepositoryRef
  readonly number: number
  readonly ready: boolean
  readonly merged: boolean
  readonly reason?: string
}

export type OutstandingPullRequest = {
  readonly repository: RepositoryRef
  readonly number: number
}

export interface PullRequestsInterface {
  readonly readiness: (input: {
    readonly change: Change
    readonly repository: RepositoryRef
    /** The click path forgets cached reads and fetches before deciding; the poll does not. */
    readonly fresh: boolean
  }) => Effect.Effect<PullRequestState, ProviderError>
  readonly merge: (input: {
    readonly change: Change
    readonly repository: RepositoryRef
    readonly number: number
  }) => Effect.Effect<string | undefined, ProviderError>
  readonly outstanding: (change: Change) => Effect.Effect<readonly OutstandingPullRequest[], ProviderError>
}

export class PullRequests extends Context.Tag("corvi/workflows/PullRequests")<PullRequests, PullRequestsInterface>() {}

export interface IssuesInterface {
  /** The completion steps this change's integrations plan, in order; empty when none apply. The
   * workflow journals them as `waiting` before anything runs. */
  readonly plan: (change: Change) => Effect.Effect<readonly OperationStep[], ProviderError>
  /** Run one planned step; a note may explain what it did. */
  readonly run: (input: {
    readonly change: Change
    readonly stepId: string
  }) => Effect.Effect<string | undefined, ProviderError>
  /** Where the issue stands, for a cancellation's loose ends: one line each. */
  readonly current: (change: Change) => Effect.Effect<readonly string[], ProviderError>
}

export class Issues extends Context.Tag("corvi/workflows/Issues")<Issues, IssuesInterface>() {}

export interface TerminalSessionsInterface {
  /** Stops the session this change owns; never one chosen by name, port, or resemblance. */
  readonly stop: (changeId: ChangeId) => Effect.Effect<void, TerminalError>
}

export class TerminalSessions extends Context.Tag("corvi/workflows/TerminalSessions")<
  TerminalSessions,
  TerminalSessionsInterface
>() {}

export interface Interface {
  readonly assessCompletion: (
    changeId: ChangeId,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<
    Readiness,
    ChangeNotFound | ChangeStoreError | RepositoryStoreError | ProviderError | CheckoutError
  >
  readonly completeChange: (input: {
    readonly changeId: ChangeId
    readonly acknowledgements?: readonly Acknowledgement[]
    /** A fresh assessment for this operation. When absent the workflow takes one itself; when
     * present the app's click-path check is the one that ran, so no second check repeats it. */
    readonly assessment?: Readiness
  }) => Effect.Effect<
    LifecycleOutcome,
    | ChangeNotFound
    | InvalidTransition
    | ChangeConflict
    | ChangeOperationInProgress
    | ChangeStoreError
    | RepositoryStoreError
    | ProviderError
    | TerminalError
    | CheckoutError
  >
  readonly assessCancellation: (
    changeId: ChangeId,
  ) => Effect.Effect<Readiness, ChangeNotFound | ChangeStoreError | RepositoryStoreError | CheckoutError>
  readonly cancelChange: (input: {
    readonly changeId: ChangeId
    readonly acknowledgements?: readonly Acknowledgement[]
  }) => Effect.Effect<
    LifecycleOutcome,
    | ChangeNotFound
    | InvalidTransition
    | ChangeConflict
    | ChangeOperationInProgress
    | ChangeStoreError
    | RepositoryStoreError
    | ProviderError
    | TerminalError
    | CheckoutError
  >
}

export class ChangeLifecycle extends Context.Tag("corvi/workflows/ChangeLifecycle")<ChangeLifecycle, Interface>() {}

const ideaReason = (change: Change): LifecycleReason => ({
  code: "idea",
  kind: "hard",
  text: "still an idea: start the work before completing it",
  facts: `idea:${change.changeId}`,
})

const finishedReason = (change: Change): LifecycleReason => ({
  code: "finished",
  kind: "hard",
  text: `already ${change.phase.toLowerCase()}`,
  facts: `finished:${change.phase}`,
})

const readinessFrom = (
  reasons: readonly LifecycleReason[],
  toMerge: readonly OutstandingPullRequest[],
): Readiness =>
  reasons.some((reason) => reason.kind === "hard")
    ? { _tag: "Blocked", reasons, toMerge }
    : reasons.length > 0
      ? { _tag: "AcknowledgementRequired", reasons, toMerge }
      : { _tag: "Ready", toMerge }

const isAcknowledged = (reason: LifecycleReason, acknowledgements: readonly Acknowledgement[]): boolean =>
  acknowledgements.some(
    (acknowledgement) =>
      acknowledgement.code === reason.code &&
      acknowledgement.facts === reason.facts &&
      (reason.subject
        ? acknowledgement.subject?.repositoryId === reason.subject.repositoryId
        : acknowledgement.subject === undefined),
  )

const createdLinks = (links: readonly Repository[]): readonly Repository[] =>
  links.filter((link) => link.checkoutMethod === "UseNewLocationNewBranch")

type RemovalOutcome = RemovalAssessment | { readonly _tag: "Gone" }

export const layer = Layer.effect(
  ChangeLifecycle,
  Effect.gen(function* () {
    const changes = yield* ChangeService
    const links = yield* ChangeRepositories
    const repositories = yield* Repositories
    const progress = yield* OperationProgress
    const pullRequests = yield* PullRequests
    const issues = yield* Issues
    const terminals = yield* TerminalSessions
    const active = yield* Ref.make<ReadonlySet<string>>(new Set())

    const record = (changeId: ChangeId, step: OperationStep): Effect.Effect<void, ChangeStoreError> =>
      progress.record({ changeId, step })

    const subjectOf = (change: Change, link: Repository): RepositoryRef => ({
      changeId: change.changeId,
      repositoryId: link.repositoryId,
    })

    const removalSafety = (
      change: Change,
      link: Repository,
    ): Effect.Effect<RemovalOutcome, CheckoutError> =>
      repositories
        .assessRemoval({
          worktree: AbsolutePath.make(checkoutLocationOf(change, link)),
          branch: change.branch,
        })
        .pipe(
          Effect.either,
          Effect.flatMap((assessed): Effect.Effect<RemovalOutcome, CheckoutError> => {
            if (assessed._tag === "Right") return Effect.succeed(assessed.right)
            const failure = assessed.left
            if (failure._tag === "NotARepository") return Effect.succeed({ _tag: "Gone" } as const)
            return Effect.fail(failure)
          }),
        )

    const removeCheckout = (worktree: AbsolutePath): Effect.Effect<void, CheckoutError> =>
      repositories.removeWorktree({ worktree, force: true }).pipe(
        Effect.mapError((error) =>
          error._tag === "NotARepository"
            ? new CheckoutError({
                operation: "remove-worktree",
                directory: worktree,
                message: "the checkout is no longer a repository",
              })
            : error,
        ),
      )

    const cleanupBranch = (change: Change, link: Repository): Effect.Effect<BranchCleanup, CheckoutError> =>
      repositories
        .removeBranchIfIntegrated({
          repository: AbsolutePath.make(link.originalLocation),
          branch: change.branch,
        })
        .pipe(
          Effect.catchTag("NotARepository", () => Effect.succeed("absent" as const)),
        )

    const completionAssessment = (
      change: Change,
      sourceLinks: readonly Repository[],
      fresh: boolean,
    ): Effect.Effect<
      { readonly reasons: readonly LifecycleReason[]; readonly toMerge: readonly { link: Repository; number: number }[] },
      ProviderError | CheckoutError
    > =>
      Effect.gen(function* () {
        const reasons: LifecycleReason[] = []
        const toMerge: { link: Repository; number: number }[] = []
        for (const link of sourceLinks) {
          const subject = subjectOf(change, link)
          const state = yield* pullRequests.readiness({ change, repository: subject, fresh })
          if (state.merged) {
            // Already in the base; nothing to do.
          } else if (state.ready) {
            toMerge.push({ link, number: state.number })
          } else {
            reasons.push({
              code: "review-pending",
              subject,
              kind: "forceable",
              text: state.reason ?? `pull request #${state.number} is not ready`,
              facts: `review:${link.repositoryId}:${state.number}:${state.reason ?? ""}`,
            })
          }
          if (link.checkoutMethod !== "UseNewLocationNewBranch") continue
          const safety = yield* removalSafety(change, link)
          if (safety._tag === "Gone" || safety._tag === "Safe") continue
          for (const reason of safety.reasons)
            reasons.push({ ...reason, subject, kind: reason.kind, text: reason.text })
        }
        return { reasons, toMerge }
      })

    const cancellationReasons = (
      change: Change,
      sourceLinks: readonly Repository[],
    ): Effect.Effect<readonly LifecycleReason[], CheckoutError> =>
      Effect.gen(function* () {
        const reasons: LifecycleReason[] = []
        for (const link of createdLinks(sourceLinks)) {
          const subject = subjectOf(change, link)
          const safety = yield* removalSafety(change, link)
          if (safety._tag === "Gone" || safety._tag === "Safe") continue
          for (const reason of safety.reasons)
            reasons.push({ ...reason, subject, kind: reason.kind, text: reason.text })
        }
        return reasons
      })

    const withOperation = <A, E, R>(
      changeId: ChangeId,
      work: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | ChangeOperationInProgress, R> =>
      Effect.acquireUseRelease(
        Ref.modify(active, (set): [boolean, ReadonlySet<string>] =>
          set.has(changeId) ? [false, set] : [true, new Set(set).add(changeId)],
        ).pipe(
          Effect.flatMap((acquired) =>
            acquired
              ? Effect.void
              : Effect.fail(
                  new ChangeOperationInProgress({
                    changeId,
                    message: `change ${changeId} already has an operation in progress`,
                  }),
                ),
          ),
        ),
        () => work,
        () =>
          Ref.update(active, (set) => {
            const next = new Set(set)
            next.delete(changeId)
            return next
          }),
      )

    const mergeList = (
      change: Change,
      toMerge: readonly { readonly link: Repository; readonly number: number }[],
    ): readonly OutstandingPullRequest[] =>
      toMerge.map(({ link, number }) => ({ repository: subjectOf(change, link), number }))

    const detailOf = (error: unknown): string =>
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error)

    /** Record a step before and after; a failure is journaled before it propagates. */
    const runStep = <A, E, R>(
      changeId: ChangeId,
      id: string,
      label: string,
      work: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | ChangeStoreError, R> =>
      Effect.gen(function* () {
        yield* record(changeId, { id, label, state: "running" })
        const attempt: Either.Either<A, E> = yield* work.pipe(Effect.either)
        if (attempt._tag === "Left") {
          yield* record(changeId, { id, label, state: "failed", detail: detailOf(attempt.left) })
          return yield* Effect.fail(attempt.left)
        }
        yield* record(changeId, { id, label, state: "done" })
        return attempt.right
      })

    const assessCompletion = Effect.fn("ChangeLifecycle.assessCompletion")(function* (
      changeId: ChangeId,
      options?: { readonly fresh?: boolean },
    ) {
      const change = yield* changes.getChange(changeId)
      if (change.phase === "Ideation")
        return { _tag: "Blocked", reasons: [ideaReason(change)], toMerge: [] } satisfies Readiness
      if (isTerminal(change.phase))
        return { _tag: "Blocked", reasons: [finishedReason(change)], toMerge: [] } satisfies Readiness
      const sourceLinks = yield* links.listRepositories(changeId)
      const { reasons, toMerge } = yield* completionAssessment(change, sourceLinks, options?.fresh ?? false)
      return readinessFrom(reasons, mergeList(change, toMerge))
    })

    const assessCancellation = Effect.fn("ChangeLifecycle.assessCancellation")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      if (isTerminal(change.phase))
        return { _tag: "Blocked", reasons: [finishedReason(change)], toMerge: [] } satisfies Readiness
      const sourceLinks = yield* links.listRepositories(changeId)
      return readinessFrom(yield* cancellationReasons(change, sourceLinks), [])
    })

    const completeChange = Effect.fn("ChangeLifecycle.completeChange")(function* (input: {
      readonly changeId: ChangeId
      readonly acknowledgements?: readonly Acknowledgement[]
      readonly assessment?: Readiness
    }) {
      return yield* withOperation(
        input.changeId,
        Effect.gen(function* () {
          const change = yield* changes.getChange(input.changeId)
          if (change.phase === "Ideation")
            return {
              _tag: "Blocked",
              operation: "complete",
              reasons: [ideaReason(change)],
              toMerge: [],
            } satisfies LifecycleOutcome
          if (isTerminal(change.phase))
            return {
              _tag: "Blocked",
              operation: "complete",
              reasons: [finishedReason(change)],
              toMerge: [],
            } satisfies LifecycleOutcome

          const sourceLinks = yield* links.listRepositories(input.changeId)
          let assessed: Readiness
          if (input.assessment) {
            assessed = input.assessment
          } else {
            const { reasons, toMerge } = yield* completionAssessment(change, sourceLinks, true)
            assessed = readinessFrom(reasons, mergeList(change, toMerge))
          }
          const reasons = assessed._tag === "Ready" ? [] : assessed.reasons
          const toMerge = assessed.toMerge.flatMap((pullRequest) => {
            const link = sourceLinks.find(
              (entry) => entry.repositoryId === pullRequest.repository.repositoryId,
            )
            return link ? [{ link, number: pullRequest.number }] : []
          })
          if (reasons.some((reason) => reason.kind === "hard"))
            return {
              _tag: "Blocked",
              operation: "complete",
              reasons,
              toMerge: mergeList(change, toMerge),
            } satisfies LifecycleOutcome
          const acknowledgements = input.acknowledgements ?? []
          if (reasons.some((reason) => !isAcknowledged(reason, acknowledgements)))
            return {
              _tag: "NeedsAcknowledgement",
              operation: "complete",
              reasons,
              toMerge: mergeList(change, toMerge),
            } satisfies LifecycleOutcome

          // The plan first: a page opened mid-operation shows what is still coming.
          const issueSteps = yield* issues.plan(change)
          yield* record(change.changeId, {
            id: "check",
            label: "check every repository is ready",
            state: "done",
          })
          for (const { link, number } of toMerge)
            yield* record(change.changeId, {
              id: `merge:${link.originalLocation}`,
              label: `merge ${link.directoryName} #${number}`,
              state: "waiting",
            })
          for (const step of issueSteps)
            yield* record(change.changeId, { id: step.id, label: step.label, state: "waiting" })
          yield* record(change.changeId, { id: "worktrees", label: "remove the worktrees", state: "waiting" })
          yield* record(change.changeId, { id: "terminal", label: "close the terminal", state: "waiting" })
          yield* record(change.changeId, { id: "archive", label: "archive the change", state: "waiting" })

          const notes: string[] = []

          // Sequential on purpose: a failed merge stops the ones after it.
          for (const { link, number } of toMerge) {
            const id = `merge:${link.originalLocation}`
            const label = `merge ${link.directoryName} #${number}`
            const note = yield* runStep(
              change.changeId,
              id,
              label,
              pullRequests.merge({ change, repository: subjectOf(change, link), number }),
            )
            if (note) notes.push(note)
          }

          // The integrations' steps: close the ticket, comment on the issue, whatever each one
          // planned. A failure stops the completion where it stands, like any core step.
          for (const step of issueSteps) {
            const note = yield* runStep(
              change.changeId,
              step.id,
              step.label,
              issues.run({ change, stepId: step.id }),
            )
            if (note) notes.push(note)
          }

          // One journal step for the teardown, as the page has always shown it; the removal
          // rechecks each checkout before acting.
          yield* record(change.changeId, { id: "worktrees", label: "remove the worktrees", state: "running" })
          for (const link of createdLinks(sourceLinks)) {
            const id = `worktrees:${link.directoryName}`
            const label = `remove ${link.directoryName}`
            const safety = yield* removalSafety(change, link)
            if (safety._tag === "Gone") continue
            if (safety._tag !== "Safe") {
              const fresh = safety.reasons.map((reason) => ({
                ...reason,
                subject: subjectOf(change, link),
                kind: reason.kind,
                text: reason.text,
              }))
              const unacknowledged = fresh.some(
                (reason) => reason.kind === "forceable" && !isAcknowledged(reason, acknowledgements),
              )
              if (safety._tag === "Unsafe" || unacknowledged) {
                yield* record(change.changeId, {
                  id: "worktrees",
                  label: "remove the worktrees",
                  state: "failed",
                  detail: "the checkout changed since the assessment",
                })
                return safety._tag === "Unsafe"
                  ? ({
                      _tag: "Blocked",
                      operation: "complete",
                      reasons: fresh,
                      toMerge: [],
                    } satisfies LifecycleOutcome)
                  : ({
                      _tag: "NeedsAcknowledgement",
                      operation: "complete",
                      reasons: fresh,
                      toMerge: [],
                    } satisfies LifecycleOutcome)
              }
            }
            const removal = yield* Effect.either(
              removeCheckout(AbsolutePath.make(checkoutLocationOf(change, link))),
            )
            if (removal._tag === "Left") {
              yield* record(change.changeId, {
                id: "worktrees",
                label: "remove the worktrees",
                state: "failed",
                detail: detailOf(removal.left),
              })
              return yield* removal.left
            }
            yield* cleanupBranch(change, link)
          }
          yield* record(change.changeId, { id: "worktrees", label: "remove the worktrees", state: "done" })

          yield* runStep(
            change.changeId,
            "terminal",
            "close the terminal",
            terminals.stop(change.changeId),
          )

          const completed = yield* runStep(
            change.changeId,
            "archive",
            "archive the change",
            changes.transitionTo(change.changeId, "Completed"),
          )

          return { _tag: "Done", change: completed, notes, loose: [] } satisfies LifecycleOutcome
        }),
      )
    })

    const cancelChange = Effect.fn("ChangeLifecycle.cancelChange")(function* (input: {
      readonly changeId: ChangeId
      readonly acknowledgements?: readonly Acknowledgement[]
    }) {
      return yield* withOperation(
        input.changeId,
        Effect.gen(function* () {
          const change = yield* changes.getChange(input.changeId)
          if (isTerminal(change.phase))
            return {
              _tag: "Blocked",
              operation: "cancel",
              reasons: [finishedReason(change)],
              toMerge: [],
            } satisfies LifecycleOutcome

          const sourceLinks = yield* links.listRepositories(input.changeId)
          const reasons = yield* cancellationReasons(change, sourceLinks)
          if (reasons.some((reason) => reason.kind === "hard"))
            return { _tag: "Blocked", operation: "cancel", reasons, toMerge: [] } satisfies LifecycleOutcome
          const acknowledgements = input.acknowledgements ?? []
          if (reasons.some((reason) => !isAcknowledged(reason, acknowledgements)))
            return {
              _tag: "NeedsAcknowledgement",
              operation: "cancel",
              reasons,
              toMerge: [],
            } satisfies LifecycleOutcome

          const loose: string[] = []
          // The plan first: a page opened mid-operation shows what is still coming.
          yield* record(change.changeId, { id: "loose", label: "collect the loose ends", state: "waiting" })
          for (const link of createdLinks(sourceLinks))
            yield* record(change.changeId, {
              id: `worktrees:${link.directoryName}`,
              label: `remove ${link.directoryName}`,
              state: "waiting",
            })
          yield* record(change.changeId, { id: "terminal", label: "close the terminal", state: "waiting" })
          yield* record(change.changeId, { id: "archive", label: "archive the change", state: "waiting" })
          yield* record(change.changeId, { id: "loose", label: "collect the loose ends", state: "running" })
          const outstanding = yield* pullRequests.outstanding(change).pipe(Effect.either)
          if (outstanding._tag === "Right") {
            for (const pullRequest of outstanding.right)
              loose.push(
                `pull request #${pullRequest.number} is still open in ${pullRequest.repository.repositoryId}`,
              )
          } else {
            loose.push("could not read the open pull requests")
          }
          const issue = yield* issues.current(change).pipe(Effect.either)
          if (issue._tag === "Right") {
            loose.push(...issue.right)
          } else {
            loose.push("could not read the issue")
          }
          yield* record(change.changeId, { id: "loose", label: "collect the loose ends", state: "done" })

          for (const link of createdLinks(sourceLinks)) {
            const id = `worktrees:${link.directoryName}`
            const label = `remove ${link.directoryName}`
            yield* record(change.changeId, { id, label, state: "running" })
            const safety = yield* removalSafety(change, link)
            if (safety._tag === "Gone") {
              yield* record(change.changeId, { id, label, state: "done", detail: "nothing to remove" })
              continue
            }
            if (safety._tag !== "Safe") {
              const fresh = safety.reasons.map((reason) => ({
                ...reason,
                subject: subjectOf(change, link),
                kind: reason.kind,
                text: reason.text,
              }))
              const unacknowledged = fresh.some(
                (reason) => reason.kind === "forceable" && !isAcknowledged(reason, acknowledgements),
              )
              if (safety._tag === "Unsafe" || unacknowledged)
                return safety._tag === "Unsafe"
                  ? ({
                      _tag: "Blocked",
                      operation: "cancel",
                      reasons: fresh,
                      toMerge: [],
                    } satisfies LifecycleOutcome)
                  : ({
                      _tag: "NeedsAcknowledgement",
                      operation: "cancel",
                      reasons: fresh,
                      toMerge: [],
                    } satisfies LifecycleOutcome)
            }
            yield* removeCheckout(AbsolutePath.make(checkoutLocationOf(change, link)))
            const cleanup = yield* cleanupBranch(change, link)
            // The branch survives when its content is not in the base; say so.
            if (cleanup === "kept") loose.push(`the branch ${change.branch} is kept in ${link.directoryName}`)
            yield* record(change.changeId, { id, label, state: "done" })
          }

          yield* record(change.changeId, { id: "terminal", label: "close the terminal", state: "running" })
          yield* terminals.stop(change.changeId)
          yield* record(change.changeId, { id: "terminal", label: "close the terminal", state: "done" })

          yield* record(change.changeId, { id: "archive", label: "archive the change", state: "running" })
          const cancelled = yield* changes.transitionTo(change.changeId, "Cancelled")
          yield* record(change.changeId, { id: "archive", label: "archive the change", state: "done" })

          return { _tag: "Done", change: cancelled, notes: [], loose } satisfies LifecycleOutcome
        }),
      )
    })

    return { assessCompletion, assessCancellation, completeChange, cancelChange }
  }),
)
