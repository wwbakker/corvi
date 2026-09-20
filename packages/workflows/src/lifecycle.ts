/** Completion and cancellation over the capabilities.
 *
 * These are the only writers of terminal phases. An earlier assessment is never authorization:
 * every destructive step rechecks the facts it acts on, and a changed fact needs a fresh
 * acknowledgement. The journal is written step by step, so a half-finished operation stays
 * legible from a page that was never open.
 */
import { Context, Data, Effect, Layer, Ref } from "effect"

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
import type { RemovalAssessment } from "@corvi/repositories"
import { CheckoutError, Repositories } from "@corvi/repositories"

export class ChangeOperationInProgress extends Data.TaggedError("ChangeOperationInProgress")<{
  readonly changeId: ChangeId
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
  | { readonly _tag: "Ready" }
  | { readonly _tag: "AcknowledgementRequired"; readonly reasons: readonly LifecycleReason[] }
  | { readonly _tag: "Blocked"; readonly reasons: readonly LifecycleReason[] }

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
    }
  | {
      readonly _tag: "Blocked"
      readonly operation: "complete" | "cancel"
      readonly reasons: readonly LifecycleReason[]
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
  readonly transition: (change: Change) => Effect.Effect<string | undefined, ProviderError>
  /** Where the issue stands, for a cancellation's loose ends. */
  readonly current: (change: Change) => Effect.Effect<string | undefined, ProviderError>
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
  ) => Effect.Effect<
    Readiness,
    ChangeNotFound | ChangeStoreError | RepositoryStoreError | ProviderError | CheckoutError
  >
  readonly completeChange: (input: {
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

const readinessFrom = (reasons: readonly LifecycleReason[]): Readiness =>
  reasons.some((reason) => reason.kind === "hard")
    ? { _tag: "Blocked", reasons }
    : reasons.length > 0
      ? { _tag: "AcknowledgementRequired", reasons }
      : { _tag: "Ready" }

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
      repositories.removeWorktree({ worktree, force: false }).pipe(
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

    const completionAssessment = (
      change: Change,
      sourceLinks: readonly Repository[],
    ): Effect.Effect<
      { readonly reasons: readonly LifecycleReason[]; readonly toMerge: readonly { link: Repository; number: number }[] },
      ProviderError | CheckoutError
    > =>
      Effect.gen(function* () {
        const reasons: LifecycleReason[] = []
        const toMerge: { link: Repository; number: number }[] = []
        for (const link of sourceLinks) {
          const subject = subjectOf(change, link)
          const state = yield* pullRequests.readiness({ change, repository: subject })
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
            acquired ? Effect.void : Effect.fail(new ChangeOperationInProgress({ changeId })),
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

    const assessCompletion = Effect.fn("ChangeLifecycle.assessCompletion")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      if (change.phase === "Ideation") return { _tag: "Blocked", reasons: [ideaReason(change)] } satisfies Readiness
      if (isTerminal(change.phase))
        return { _tag: "Blocked", reasons: [finishedReason(change)] } satisfies Readiness
      const sourceLinks = yield* links.listRepositories(changeId)
      const { reasons } = yield* completionAssessment(change, sourceLinks)
      return readinessFrom(reasons)
    })

    const assessCancellation = Effect.fn("ChangeLifecycle.assessCancellation")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      if (isTerminal(change.phase))
        return { _tag: "Blocked", reasons: [finishedReason(change)] } satisfies Readiness
      const sourceLinks = yield* links.listRepositories(changeId)
      return readinessFrom(yield* cancellationReasons(change, sourceLinks))
    })

    const completeChange = Effect.fn("ChangeLifecycle.completeChange")(function* (input: {
      readonly changeId: ChangeId
      readonly acknowledgements?: readonly Acknowledgement[]
    }) {
      return yield* withOperation(
        input.changeId,
        Effect.gen(function* () {
          const change = yield* changes.getChange(input.changeId)
          if (change.phase === "Ideation")
            return { _tag: "Blocked", operation: "complete", reasons: [ideaReason(change)] } satisfies LifecycleOutcome
          if (isTerminal(change.phase))
            return { _tag: "Blocked", operation: "complete", reasons: [finishedReason(change)] } satisfies LifecycleOutcome

          const sourceLinks = yield* links.listRepositories(input.changeId)
          const { reasons, toMerge } = yield* completionAssessment(change, sourceLinks)
          if (reasons.some((reason) => reason.kind === "hard"))
            return { _tag: "Blocked", operation: "complete", reasons } satisfies LifecycleOutcome
          const acknowledgements = input.acknowledgements ?? []
          if (reasons.some((reason) => !isAcknowledged(reason, acknowledgements)))
            return { _tag: "NeedsAcknowledgement", operation: "complete", reasons } satisfies LifecycleOutcome

          const notes: string[] = []
          yield* record(change.changeId, {
            id: "check",
            label: "check every repository is ready",
            state: "done",
          })

          // Sequential on purpose: a failed merge stops the ones after it.
          for (const { link, number } of toMerge) {
            const id = `merge:${link.directoryName}`
            const label = `merge ${link.directoryName} #${number}`
            yield* record(change.changeId, { id, label, state: "running" })
            const note = yield* pullRequests.merge({ change, repository: subjectOf(change, link), number })
            if (note) notes.push(note)
            yield* record(change.changeId, { id, label, state: "done", ...(note ? { detail: note } : {}) })
          }

          yield* record(change.changeId, { id: "issues", label: "transition the ticket", state: "running" })
          const issueNote = yield* issues.transition(change)
          if (issueNote) notes.push(issueNote)
          yield* record(change.changeId, {
            id: "issues",
            label: "transition the ticket",
            state: "done",
            ...(issueNote ? { detail: issueNote } : {}),
          })

          // Recheck before the destructive step: the earlier assessment is not authorization.
          for (const link of createdLinks(sourceLinks)) {
            const id = `worktrees:${link.directoryName}`
            const label = `remove ${link.directoryName}`
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
              if (safety._tag === "Unsafe" || unacknowledged) {
                yield* record(change.changeId, {
                  id,
                  label,
                  state: "failed",
                  detail: "the checkout changed since the assessment",
                })
                return safety._tag === "Unsafe"
                  ? ({ _tag: "Blocked", operation: "complete", reasons: fresh } satisfies LifecycleOutcome)
                  : ({ _tag: "NeedsAcknowledgement", operation: "complete", reasons: fresh } satisfies LifecycleOutcome)
              }
            }
            yield* record(change.changeId, { id, label, state: "running" })
            yield* removeCheckout(AbsolutePath.make(checkoutLocationOf(change, link)))
            yield* record(change.changeId, { id, label, state: "done" })
          }

          yield* record(change.changeId, { id: "terminal", label: "close the terminal", state: "running" })
          yield* terminals.stop(change.changeId)
          yield* record(change.changeId, { id: "terminal", label: "close the terminal", state: "done" })

          yield* record(change.changeId, { id: "archive", label: "archive the change", state: "running" })
          const completed = yield* changes.transitionTo(change.changeId, "Completed")
          yield* record(change.changeId, { id: "archive", label: "archive the change", state: "done" })

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
            return { _tag: "Blocked", operation: "cancel", reasons: [finishedReason(change)] } satisfies LifecycleOutcome

          const sourceLinks = yield* links.listRepositories(input.changeId)
          const reasons = yield* cancellationReasons(change, sourceLinks)
          if (reasons.some((reason) => reason.kind === "hard"))
            return { _tag: "Blocked", operation: "cancel", reasons } satisfies LifecycleOutcome
          const acknowledgements = input.acknowledgements ?? []
          if (reasons.some((reason) => !isAcknowledged(reason, acknowledgements)))
            return { _tag: "NeedsAcknowledgement", operation: "cancel", reasons } satisfies LifecycleOutcome

          const loose: string[] = []
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
            if (issue.right) loose.push(issue.right)
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
                  ? ({ _tag: "Blocked", operation: "cancel", reasons: fresh } satisfies LifecycleOutcome)
                  : ({ _tag: "NeedsAcknowledgement", operation: "cancel", reasons: fresh } satisfies LifecycleOutcome)
            }
            yield* removeCheckout(AbsolutePath.make(checkoutLocationOf(change, link)))
            // The removal keeps a branch whose content the base does not have; say so.
            if (safety._tag === "NeedsAcknowledgement")
              loose.push(`the branch ${change.branch} is kept in ${link.directoryName}`)
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
