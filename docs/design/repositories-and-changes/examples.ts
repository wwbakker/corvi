/** Design prototype: a typechecked caller and the server's layer composition. */
import { Effect, Layer } from "effect"

import { ChangeRepositories, layer as changeRepositoriesLayer } from "./change-repositories.ts"
import { ChangeService, layer as changeServiceLayer } from "./changes.ts"
import type {
  ChangeConflict,
  ChangeId,
  ChangeNotFound,
  ChangeStoreError,
  InvalidTransition,
  RepositoryStoreError,
} from "./model.ts"
import { Repositories, layer as repositoriesLayer } from "./repositories.ts"
import { ChangeWork, layer as changeWorkLayer, type StartOutcome } from "./workflows.ts"

/**
 * The workflow layer once the capabilities are provided. What remains are the adapters the
 * application supplies: the change store, Git, and the progress port.
 */
export const workflowLayer = changeWorkLayer.pipe(
  Layer.provide(changeServiceLayer),
  Layer.provide(changeRepositoriesLayer),
  Layer.provide(repositoriesLayer),
)

export type StartChangeError =
  | ChangeNotFound
  | InvalidTransition
  | ChangeConflict
  | ChangeStoreError
  | RepositoryStoreError

/** A caller with no HTTP in sight: the route and a future status action call the same function. */
export const startChangeCaller = (
  changeId: ChangeId,
): Effect.Effect<StartOutcome, StartChangeError, ChangeWork> =>
  Effect.gen(function* () {
    const work = yield* ChangeWork
    return yield* work.startChange(changeId)
  })
