/** The dashboard read and the start workflow over the capabilities.
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
  type ChangeConflict,
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
  type CheckoutError,
  type CheckoutInspection,
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

export type StartOutcome =
  | {
      readonly _tag: "Started"
      readonly change: Change
      readonly repositories: readonly Repository[]
    }
  | {
      readonly _tag: "PartiallyStarted"
      readonly change: Change
      readonly repositories: readonly Repository[]
      readonly failures: readonly ProvisionFailure[]
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
  readonly startChange: (
    changeId: ChangeId,
  ) => Effect.Effect<
    StartOutcome,
    ChangeNotFound | InvalidTransition | ChangeConflict | ChangeStoreError | RepositoryStoreError
  >
}

export class ChangeWork extends Context.Tag("corvi/ChangeWork")<ChangeWork, Interface>() {}

export const describeProvisionError = (error: NotARepository | CheckoutError): string =>
  error._tag === "NotARepository" ? `${error.directory} is not a repository` : error.message

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

    // The checkout-method enum is application policy; the capability only sees concrete inputs.
    const provisionLink = (change: Change, repository: Repository): Effect.Effect<void, NotARepository | CheckoutError> => {
      switch (repository.checkoutMethod) {
        case "UseOriginalLocationOriginalBranch":
          return Effect.void
        case "UseOriginalLocationNewBranch":
          return repositories
            .provisionInPlace({
              source: AbsolutePath.make(repository.originalLocation),
              branch: change.branch,
            })
            .pipe(Effect.asVoid)
        case "UseNewLocationNewBranch":
          return repositories.provisionLinkedWorktree({
            source: AbsolutePath.make(repository.originalLocation),
            directory: AbsolutePath.make(checkoutLocationOf(change, repository)),
            branch: change.branch,
          })
      }
    }

    const startChange = Effect.fn("ChangeWork.startChange")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      if (change.phase !== "Ideation")
        return yield* new InvalidTransition({ changeId, from: change.phase, to: "Implementation" })

      // Persist first: the change survives provisioning that fails part way.
      const started = yield* changes.transitionTo(changeId, "Implementation")

      const repositoriesForChange = yield* links.listRepositories(changeId)
      const provisioned: Repository[] = []
      const failures: ProvisionFailure[] = []
      for (const repository of repositoriesForChange) {
        const label = `checkout ${repository.directoryName}`
        yield* progress.record({ changeId, step: { id: repository.repositoryId, label, state: "running" } })
        const attempt = yield* provisionLink(started, repository).pipe(Effect.either)
        if (attempt._tag === "Right") {
          provisioned.push(repository)
          yield* progress.record({ changeId, step: { id: repository.repositoryId, label, state: "done" } })
        } else {
          failures.push({ repositoryId: repository.repositoryId, error: attempt.left })
          yield* progress.record({
            changeId,
            step: {
              id: repository.repositoryId,
              label,
              state: "failed",
              detail: describeProvisionError(attempt.left),
            },
          })
        }
      }

      if (failures.length > 0)
        return {
          _tag: "PartiallyStarted",
          change: started,
          repositories: provisioned,
          failures,
        } satisfies StartOutcome
      return { _tag: "Started", change: started, repositories: provisioned } satisfies StartOutcome
    })

    return { inspectChangeRepositories, startChange }
  }),
)
