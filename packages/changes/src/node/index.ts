/** Node composition: the file-backed store and the services over it. */
import { Layer } from "effect"

import { ChangeService, layer as changesLayer } from "../changes.ts"
import { ChangeRepositories, layer as changeRepositoriesLayer } from "../change-repositories.ts"
import type { ChangeStore } from "../store.ts"

export { layer as storeLayer, migrateStoredRecords, type RootPair } from "./store.ts"
export { layer as progressLayer } from "./progress.ts"

/** Change records and repository links over the store. The store itself is provided above. */
export const layer: Layer.Layer<ChangeService | ChangeRepositories, never, ChangeStore> = Layer.mergeAll(
  changesLayer,
  changeRepositoriesLayer,
)
