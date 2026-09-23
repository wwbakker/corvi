/** The first wired slice: the dashboard read of a change's repositories.
 *
 * Transport adapter only: it decodes the path, calls the workflow, encodes the DTO, and maps
 * domain failures to the transport taxonomy. The data comes from the legacy records through the
 * read-only projection until the association migration lands; writes stay disabled there.
 */
import { Effect, Layer } from "effect"

import { layer as changesNodeLayer, progressLayer, storeLayer } from "@corvi/changes/node"
import type { RepositoryViewDto } from "@corvi/contracts/api"
import { ChangeId } from "@corvi/contracts/changes"
import { layer as repositoriesNodeLayer } from "@corvi/repositories/node"
import { ChangeWork, layer as changeWorkLayer, type RepositoryView } from "@corvi/workflows"
import { InternalError, NotFoundError } from "@corvi/contracts/errors"
import { runRoute } from "../capabilities/effect/run.ts"
import { guard, json } from "../capabilities/web.ts"
import { changePairs } from "./server/store.ts"

const toDto = (view: RepositoryView): RepositoryViewDto => ({
  repositoryId: view.repository.repositoryId,
  directoryName: view.repository.directoryName,
  state: view.state,
  checkoutLocation: view.checkoutLocation,
  checkout: view.checkout,
})

const param = (req: Request, name: string): string =>
  (req as Request & { params?: Record<string, string> }).params?.[name] ?? ""

/** Built per request: the layers describe no resources, so construction is cheap and reads see
 * the current configuration. */
const sliceLayer = (): Layer.Layer<ChangeWork> =>
  changeWorkLayer.pipe(
    Layer.provide(changesNodeLayer),
    Layer.provide(storeLayer({ roots: changePairs() })),
    Layer.provide(repositoriesNodeLayer),
    Layer.provide(progressLayer({ roots: changePairs() })),
  )

export const inspectRepositories = (req: Request): Promise<Response> =>
  runRoute(
    Effect.gen(function* () {
      const changeId = ChangeId.make(param(req, "id"))
      const work = yield* ChangeWork
      const views = yield* work.inspectChangeRepositories(changeId)
      return json(views.map(toDto))
    }).pipe(
      Effect.catchTags({
        ChangeNotFound: (error) =>
          Effect.fail(new NotFoundError({ message: `change not found: ${error.changeId}` })),
        ChangeStoreError: (error) => Effect.fail(new InternalError({ message: error.message })),
        RepositoryStoreError: (error) => Effect.fail(new InternalError({ message: error.message })),
        CheckoutError: (error) => Effect.fail(new InternalError({ message: error.message })),
      }),
      Effect.provide(sliceLayer()),
    ),
  )

export const repositoriesRoutes = guard({
  "/api/changes/:id/repositories": {
    GET: (req: Request) => inspectRepositories(req),
  },
})
