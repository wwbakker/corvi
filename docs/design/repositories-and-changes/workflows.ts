/** Design prototype: the dashboard read and the start workflow over the capabilities. */
import { Context, Effect, Layer } from "effect"

import { ChangeRepositories } from "./change-repositories.ts"
import { ChangeService } from "./changes.ts"
import {
  checkoutLocationOf,
  InvalidTransition,
  stateOf,
  type Change,
  type ChangeConflict,
  type ChangeId,
  type ChangeNotFound,
  type ChangeStoreError,
  type Repository,
  type RepositoryId,
  type RepositoryState,
  type RepositoryStoreError,
} from "./model.ts"
import { AbsolutePath } from "./paths.ts"
import {
  Repositories,
  type CheckoutError,
  type CheckoutInspection,
  type NotARepository,
} from "./repositories.ts"

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
export type OperationStep = {
  readonly id: string
  readonly label: string
  readonly state: "running" | "done" | "failed"
  readonly detail?: string
}

export interface ProgressInterface {
  readonly record: (input: {
    readonly changeId: ChangeId
    readonly step: OperationStep
  }) => Effect.Effect<void, ChangeStoreError>
}

export class OperationProgress extends Context.Tag("corvi/OperationProgress")<OperationProgress, ProgressInterface>() {}

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
    const provisionLink = (change: Change, repository: Repository) => {
      switch (repository.checkoutMethod) {
        case "UseOriginalLocationOriginalBranch":
          return Effect.void
        case "UseOriginalLocationNewBranch":
          return repositories.switchBranch({
            worktree: AbsolutePath.make(repository.originalLocation),
            branch: change.branch,
          })
        case "UseNewLocationNewBranch":
          return repositories.addWorktree({
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
