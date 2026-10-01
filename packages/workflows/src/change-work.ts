/** The dashboard read, checkout provisioning, and the start workflow over the capabilities.
 *
 * Workflows are ordinary Effect programs: the route and a future status action call the same
 * function. They compose capabilities; they do not import Git, HTTP, or persistence.
 */
import { Context, Effect, Layer } from "effect"

import { ChangeRepositories } from "@corvi/changes/repositories"
import { ChangeService } from "@corvi/changes/changes"
import { OperationProgress, type OperationStep, type ProgressInterface } from "@corvi/changes/progress"
import { checkoutLocationOf, stateOf } from "@corvi/changes/rules"
import {
  InvalidTransition,
  RepositoryNotFound,
  type ChangeConflict,
  type ChangeFormatTooNew,
  type ChangeNotFound,
  type ChangeStoreError,
  type RepositoryStoreError,
} from "@corvi/changes/errors"
import { AbsolutePath } from "@corvi/contracts/paths"
import type {
  Change,
  ChangeId,
  Repository,
  RepositoryId,
  RepositoryState,
} from "@corvi/contracts/changes"
import {
  Repositories,
  CheckoutError,
  type CheckoutInspection,
  type ForwardOutcome,
  type NotARepository,
} from "@corvi/repositories"

export type RepositoryView = {
  readonly repository: Repository
  readonly state: RepositoryState
  readonly checkoutLocation: string
  readonly checkout: CheckoutInspection
}

export type ProvisionFailure = {
  readonly repositoryId: RepositoryId
  readonly error: NotARepository | CheckoutError
}

/** What one repository's refresh did. The fast-forward outcomes come from the capability;
 * `FetchFailed` is the freshness step's own refusal — nothing was created or moved on refs that
 * may be stale — and `None` is the cases with nothing to refresh (adopted as checked out, no
 * base to fast-forward to). */
export type RefreshReport =
  | ForwardOutcome
  | { readonly _tag: "FetchFailed"; readonly reason: string }
  | { readonly _tag: "None"; readonly reason: string }

/** One repository's whole checkout run: fetch, provision, fast-forward. The refresh is always
 * there to read; `error` is why the checkout work stopped, then. */
export type CheckoutOutcome = {
  readonly repository: Repository
  readonly checkoutLocation: string
  readonly error?: NotARepository | CheckoutError
  readonly refresh: RefreshReport
}

export type StartOutcome =
  | {
      readonly _tag: "Started"
      readonly change: Change
      readonly repositories: readonly Repository[]
      readonly reports: readonly CheckoutOutcome[]
    }
  | {
      readonly _tag: "PartiallyStarted"
      readonly change: Change
      readonly repositories: readonly Repository[]
      readonly failures: readonly ProvisionFailure[]
      readonly reports: readonly CheckoutOutcome[]
    }

/** One journal entry of an operation that can stop half way. */
export { OperationProgress, type OperationStep, type ProgressInterface } from "@corvi/changes/progress"

export interface Interface {
  readonly inspectChangeRepositories: (
    changeId: ChangeId,
  ) => Effect.Effect<
    readonly RepositoryView[],
    ChangeNotFound | ChangeStoreError | RepositoryStoreError | CheckoutError
  >
  /** One repository's checkout work, through the one policy creation, repository edits and
   * Start work all run: fetch (when there is a remote), provision, then fast-forward-only. A
   * checkout is never created or moved on refs that may be stale, and never rewritten.
   * Unserialized by design: the caller holds `withCheckoutLock` for its whole critical section,
   * as every server checkout operation does — a future caller must do the same. */
  readonly provisionRepository: (
    changeId: ChangeId,
    repositoryId: RepositoryId,
  ) => Effect.Effect<
    CheckoutOutcome,
    ChangeNotFound | RepositoryNotFound | ChangeStoreError | RepositoryStoreError
  >
  /** Every repository's checkout work, one journal entry per repository. Unserialized like
   * `provisionRepository`: the caller holds `withCheckoutLock`. */
  readonly provisionChange: (
    changeId: ChangeId,
  ) => Effect.Effect<
    readonly CheckoutOutcome[],
    ChangeNotFound | ChangeFormatTooNew | ChangeStoreError | RepositoryStoreError
  >
  readonly startChange: (
    changeId: ChangeId,
  ) => Effect.Effect<
    StartOutcome,
    | ChangeNotFound
    | InvalidTransition
    | ChangeConflict
    | ChangeFormatTooNew
    | ChangeStoreError
    | RepositoryStoreError
  >
}

export class ChangeWork extends Context.Tag("corvi/ChangeWork")<ChangeWork, Interface>() {}

export const describeProvisionError = (error: NotARepository | CheckoutError): string =>
  error._tag === "NotARepository" ? `${error.directory} is not a repository` : error.message

/** What the refresh did, in the words the journal shows. */
export const describeRefresh = (refresh: RefreshReport): string => {
  switch (refresh._tag) {
    case "Advanced":
      return `advanced to ${refresh.to}`
    case "Current":
      return "current"
    case "LeftAlone":
      return `left-alone: ${refresh.reason}`
    case "FetchFailed":
      return `fetch failed: ${refresh.reason}`
    case "None":
      return refresh.reason
  }
}

/** What one repository's whole run came to: a stopped run says why, a finished one says what the
 * refresh did. */
export const describeCheckout = (outcome: CheckoutOutcome): string => {
  if (outcome.refresh._tag === "FetchFailed") return describeRefresh(outcome.refresh)
  return outcome.error ? describeProvisionError(outcome.error) : describeRefresh(outcome.refresh)
}

/** One checkout run per change at a time — process-wide, because creation, a repository row's
 * retry and Start work arrive on separate requests, each building its own layer instance, and
 * two of them racing would fight over one destination. The lock queues rather than refusing: the
 * second run finds the checkout the first one made and reports it as current. The map grows one
 * small semaphore per change this process has provisioned and is its sole owner.
 *
 * Exported so the server's checkout operations can hold it across their whole critical section —
 * the presence work and a repository teardown included — and the policy runs inside without
 * taking it again. */
const checkoutLocks = new Map<ChangeId, Effect.Semaphore>()
const checkoutLockFor = (changeId: ChangeId): Effect.Semaphore => {
  // The synchronous section cannot interleave, so a change gets exactly one semaphore.
  const found = checkoutLocks.get(changeId)
  if (found) return found
  const created = Effect.unsafeMakeSemaphore(1)
  checkoutLocks.set(changeId, created)
  return created
}

export const withCheckoutLock = <A, E, R>(
  changeId: ChangeId,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => checkoutLockFor(changeId).withPermits(1)(work)

export const layer = Layer.effect(
  ChangeWork,
  Effect.gen(function* () {
    const changes = yield* ChangeService
    const links = yield* ChangeRepositories
    const repositories = yield* Repositories
    const progress = yield* OperationProgress

    const inspectChangeRepositories = Effect.fn("ChangeWork.inspectChangeRepositories")(function* (
      changeId: ChangeId,
    ) {
      const change = yield* changes.getChange(changeId)
      const repositoriesForChange = yield* links.listRepositories(changeId)
      return yield* Effect.forEach(
        repositoriesForChange,
        (repository) => {
          const checkoutLocation = checkoutLocationOf(change, repository)
          return repositories.inspectCheckout(AbsolutePath.make(checkoutLocation)).pipe(
            Effect.map(
              (checkout): RepositoryView => ({
                repository,
                state: stateOf(change),
                checkoutLocation,
                checkout,
              }),
            ),
          )
        },
        { concurrency: 4 },
      )
    })

    /** What a checkout's branch should be fresh against: the base the change chose for it, the
     * repository's default for a change branch, or the remote counterpart of a named existing
     * branch — when that counterpart exists. A branch adopted as checked out has no freshness
     * source at all. */
    const refreshTargetOf = (
      repository: Repository,
      source: AbsolutePath,
    ): Effect.Effect<string | undefined, NotARepository | CheckoutError> => {
      switch (repository.branch.kind) {
        case "current":
          return Effect.succeed(undefined)
        case "change":
          return repository.base ? Effect.succeed(repository.base) : repositories.defaultBranch(source)
        case "existing":
          return repositories.resolveExistingBranch(source, repository.branch.name).pipe(
            Effect.map((selected) => selected.remoteRef),
          )
      }
    }

    // The checkout policy belongs to the application: the link's location and branch kind map
    // to the capability's concrete inputs here, and nowhere else. Freshness is one sequence —
    // fetch when there is anything to fetch, provision, fast-forward-only — and a fetch that
    // will not answer stops the repository before anything is created or moved. Every checkout
    // problem is captured as the outcome's data, so one repository's trouble is a report, never
    // a stopped run.
    const provisionLink = (change: Change, repository: Repository): Effect.Effect<CheckoutOutcome> =>
      Effect.gen(function* () {
        const checkoutLocation = checkoutLocationOf(change, repository)
        const source = AbsolutePath.make(repository.originalLocation)
        const outcome = (
          refresh: RefreshReport,
          error?: NotARepository | CheckoutError,
        ): CheckoutOutcome => ({
          repository,
          checkoutLocation,
          refresh,
          ...(error ? { error } : {}),
        })

        // Adopting whatever the checkout has checked out is no work at all — and only possible
        // where that checkout already is. No fetch, no switch, no refresh: the change follows
        // the checkout as it stands. The combination with a new worktree is refused at the wire;
        // a record written by hand can still hold one, and then it is this repository's failure,
        // not the run's.
        if (repository.branch.kind === "current")
          return repository.location === "new"
            ? outcome(
                { _tag: "None", reason: "the checkout was not provisioned" },
                new CheckoutError({
                  operation: "add-worktree",
                  directory: checkoutLocation,
                  message: "a new worktree cannot use the branch a source checkout has checked out",
                }),
              )
            : outcome({ _tag: "None", reason: "adopted as checked out" })

        const selection = repository.branch.kind === "existing"
          ? yield* repositories.resolveExistingBranch(source, repository.branch.name).pipe(Effect.either)
          : undefined
        if (selection?._tag === "Left")
          return outcome({ _tag: "None", reason: "could not resolve the branch" }, selection.left)
        const selected = selection?._tag === "Right" ? selection.right : undefined
        const remoteName = selected?.remote ?? "origin"
        const remote = yield* repositories.hasRemote(source, remoteName).pipe(Effect.either)
        if (remote._tag === "Left")
          return outcome({ _tag: "None", reason: "could not read the repository" }, remote.left)
        // New branches still fetch origin; an existing selection fetches the remote its
        // freshness ref belongs to, before attaching or advancing anything.
        if (remote.right) {
          const fetched = yield* repositories.fetchRemote(source, remoteName).pipe(Effect.either)
          if (fetched._tag === "Left")
            return outcome({ _tag: "FetchFailed", reason: fetched.left.message }, fetched.left)
        }

        // Resolve again after fetching: deleted or changed refs must not be attached from stale
        // metadata. Keep the recorded selection for provisioning and the local name for checks.
        const refreshedSelection = repository.branch.kind === "existing"
          ? yield* repositories.resolveExistingBranch(source, repository.branch.name).pipe(Effect.either)
          : undefined
        if (refreshedSelection?._tag === "Left")
          return outcome({ _tag: "None", reason: "could not resolve the branch" }, refreshedSelection.left)
        const branch = refreshedSelection?._tag === "Right" ? refreshedSelection.right.branch : change.branch
        const requestedBranch = repository.branch.kind === "existing" ? repository.branch.name : branch
        // An existing branch is attached — a remote-only one gets a local tracking branch.
        const createMissing = repository.branch.kind === "change"
        const base = repository.branch.kind === "change" ? repository.base : undefined
        if (repository.location === "original") {
          const attempt = yield* repositories
            .provisionInPlace({ source, branch: requestedBranch, createMissing, ...(base ? { base } : {}) })
            .pipe(Effect.either)
          if (attempt._tag === "Left")
            return outcome({ _tag: "None", reason: "the checkout was not provisioned" }, attempt.left)
          // An in-place checkout with uncommitted work is left exactly as it is — it is on no
          // expected branch, so there is nothing to refresh.
          if (attempt.right === "skipped-dirty")
            return outcome({ _tag: "LeftAlone", reason: "uncommitted changes in the checkout" })
        } else {
          const attempt = yield* repositories
            .provisionLinkedWorktree({
              source,
              directory: AbsolutePath.make(checkoutLocation),
              branch: requestedBranch,
              createMissing,
              ...(base ? { base } : {}),
            })
            .pipe(Effect.either)
          if (attempt._tag === "Left")
            return outcome({ _tag: "None", reason: "the checkout was not provisioned" }, attempt.left)
        }

        // The plan's promise: a checkout not on the expected branch is never refreshed. An
        // agent or a user may have switched away inside the worktree, and a refresh moves
        // whatever is checked out — including a branch this change never asked for. Nor did
        // provisioning deliver what it promised, which is worth saying where a retry is offered
        // rather than reading as a quiet success. (A dirty in-place checkout already returned
        // above: left alone by policy, not missing its branch.)
        const observed = yield* repositories
          .inspectCheckout(AbsolutePath.make(checkoutLocation))
          .pipe(Effect.either)
        if (observed._tag === "Left")
          return outcome({ _tag: "None", reason: "could not read the checkout" }, observed.left)
        const on = observed.right._tag === "Present" ? observed.right.branch : undefined
        if (on !== branch) {
          const reason = on
            ? `the checkout is on ${on}, not ${branch}`
            : `the checkout is not on ${branch}`
          return outcome(
            { _tag: "LeftAlone", reason },
            new CheckoutError({
              operation: repository.location === "new" ? "add-worktree" : "switch",
              directory: checkoutLocation,
              message: reason,
            }),
          )
        }

        const target = yield* refreshTargetOf(repository, source).pipe(Effect.either)
        if (target._tag === "Left")
          return outcome({ _tag: "None", reason: "could not read the base" }, target.left)
        if (!target.right) return outcome({ _tag: "None", reason: "nothing to fast-forward to" })
        const forward = yield* repositories
          .fastForwardBranch({
            directory: AbsolutePath.make(checkoutLocation),
            to: target.right,
          })
          .pipe(Effect.either)
        if (forward._tag === "Left")
          return outcome({ _tag: "None", reason: "not refreshed" }, forward.left)
        return outcome(forward.right)
      })

    const provisionRepository = Effect.fn("ChangeWork.provisionRepository")(function* (
      changeId: ChangeId,
      repositoryId: RepositoryId,
    ) {
      const change = yield* changes.getChange(changeId)
      const repository = yield* links.listRepositories(changeId).pipe(
        Effect.map((all) => all.find((entry) => entry.repositoryId === repositoryId)),
      )
      if (!repository)
        return yield* new RepositoryNotFound({
          changeId,
          repositoryId,
          message: `repository ${repositoryId} is not part of change ${changeId}`,
        })
      return yield* provisionLink(change, repository)
    })

    const provisionChange = Effect.fn("ChangeWork.provisionChange")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      const repositoriesForChange = yield* links.listRepositories(changeId)
      const outcomes: CheckoutOutcome[] = []
      for (const repository of repositoriesForChange) {
        const label = `checkout ${repository.directoryName}`
        yield* progress.record({ changeId, step: { id: repository.repositoryId, label, state: "running" } })
        const done = yield* provisionLink(change, repository)
        outcomes.push(done)
        yield* progress.record({
          changeId,
          step: {
            id: repository.repositoryId,
            label,
            ...(done.error ? { state: "failed" as const } : { state: "done" as const }),
            detail: describeCheckout(done),
          },
        })
      }
      return outcomes
    })

    const startChange = Effect.fn("ChangeWork.startChange")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      if (change.phase !== "Ideation")
        return yield* new InvalidTransition({
          changeId,
          from: change.phase,
          to: "Implementation",
          message: `change ${changeId} cannot start: its phase is ${change.phase}`,
        })

      // Persist first: the change survives provisioning that fails part way.
      const started = yield* changes.transitionTo(changeId, "Implementation")
      // Provisioning anything missing and refreshing what is there: a change whose worktree was
      // made at creation still picks up the base commits that landed during ideation here.
      const reports = yield* provisionChange(changeId)

      const provisioned: Repository[] = []
      const failures: ProvisionFailure[] = []
      for (const report of reports) {
        if (report.error) failures.push({ repositoryId: report.repository.repositoryId, error: report.error })
        else provisioned.push(report.repository)
      }

      if (failures.length > 0)
        return {
          _tag: "PartiallyStarted",
          change: started,
          repositories: provisioned,
          failures,
          reports,
        } satisfies StartOutcome
      return {
        _tag: "Started",
        change: started,
        repositories: provisioned,
        reports,
      } satisfies StartOutcome
    })

    return { inspectChangeRepositories, provisionRepository, provisionChange, startChange }
  }),
)
