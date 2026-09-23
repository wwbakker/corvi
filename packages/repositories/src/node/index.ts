/** Node composition of the repositories capability over the real Git adapter. */
import { Layer } from "effect"

import { Repositories, layer as repositoriesLayer } from "../repositories.ts"
import { layer as commandLayer } from "./command.ts"
import { layer as gitLayer } from "./git.ts"

export { Command, CommandError, layer as commandLayer, nodeCommand } from "./command.ts"
export { layer as gitLayer } from "./git.ts"

/** The repositories capability with nothing left to provide. */
export const layer: Layer.Layer<Repositories> = repositoriesLayer.pipe(
  Layer.provide(gitLayer),
  Layer.provide(commandLayer),
)
