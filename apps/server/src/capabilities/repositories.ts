/** Repository reads for the legacy server callers, over their existing Shell seam. */
import { Effect, Layer } from "effect"
import { AbsolutePath } from "@corvi/contracts/paths"
import { Repositories, layer as repositoriesLayer, type ExistingBranch } from "@corvi/repositories"
import { Command, gitLayer } from "@corvi/repositories/node"
import { shSoft } from "./effect/support.ts"

const commandLayer: Layer.Layer<Command> = Layer.succeed(Command, {
  run: (input) => shSoft([input.program, ...input.args], input.cwd).pipe(
    Effect.map((result) => ({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr })),
  ),
})

const repositoryReads: Layer.Layer<Repositories> = repositoriesLayer.pipe(
  Layer.provide(gitLayer),
  Layer.provide(commandLayer),
)

/** Read-only resolution. Unavailable or conflicting metadata is unknown, not a guessed branch. */
export const existingBranch = (repo: string, name: string): Effect.Effect<ExistingBranch | undefined> =>
  Effect.flatMap(Repositories, (repositories) =>
    repositories.resolveExistingBranch(AbsolutePath.make(repo), name),
  ).pipe(Effect.provide(repositoryReads), Effect.catch(() => Effect.succeed(undefined)))
