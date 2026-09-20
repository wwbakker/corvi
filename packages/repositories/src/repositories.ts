/** Checkout work on concrete locations, over the Git adapter.
 *
 * This capability does not know about changes or links: it receives a source, a destination,
 * and a branch. The checkout-method enum and its mapping belong to the caller.
 */
import { Context, Data, Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "./git.ts"

export type CheckoutInspection =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Present"; readonly branch?: string; readonly head?: string }

export class NotARepository extends Data.TaggedError("NotARepository")<{
  readonly directory: string
}> {}

export class CheckoutError extends Data.TaggedError("CheckoutError")<{
  readonly operation: "inspect" | "switch" | "add-worktree" | "remove-worktree"
  readonly directory: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Interface {
  readonly inspectCheckout: (directory: AbsolutePath) => Effect.Effect<CheckoutInspection, CheckoutError>
  readonly switchBranch: (input: {
    readonly worktree: AbsolutePath
    readonly branch: string
  }) => Effect.Effect<void, NotARepository | CheckoutError>
  readonly addWorktree: (input: {
    readonly source: AbsolutePath
    readonly directory: AbsolutePath
    readonly branch: string
  }) => Effect.Effect<void, NotARepository | CheckoutError>
  readonly removeWorktree: (input: {
    readonly worktree: AbsolutePath
    readonly force: boolean
  }) => Effect.Effect<void, NotARepository | CheckoutError>
}

export class Repositories extends Context.Tag("corvi/Repositories")<Repositories, Interface>() {}

export const layer = Layer.effect(
  Repositories,
  Effect.gen(function* () {
    const git = yield* Git.Service

    const discover = Effect.fn("Repositories.discover")(function* (
      directory: AbsolutePath,
      operation: CheckoutError["operation"],
    ) {
      const repository = yield* git.repo.discover(directory).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation,
              directory,
              message: "could not read the repository",
              cause,
            }),
        ),
      )
      if (!repository) return yield* new NotARepository({ directory })
      return repository
    })

    const inspectCheckout = Effect.fn("Repositories.inspectCheckout")(function* (directory: AbsolutePath) {
      const repository = yield* git.repo.discover(directory).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "inspect",
              directory,
              message: "could not read the checkout",
              cause,
            }),
        ),
      )
      if (!repository) return { _tag: "Missing" } satisfies CheckoutInspection
      const observed = yield* Effect.all([git.history.branch(repository), git.history.head(repository)]).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "inspect",
              directory,
              message: "could not read the checkout",
              cause,
            }),
        ),
      )
      const [branch, head] = observed
      return { _tag: "Present", branch, head } satisfies CheckoutInspection
    })

    const switchBranch = Effect.fn("Repositories.switchBranch")(function* (input: {
      readonly worktree: AbsolutePath
      readonly branch: string
    }) {
      const repository = yield* discover(input.worktree, "switch")
      yield* git.sync.checkoutRemoteBranch(repository, { branch: input.branch }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "switch",
              directory: input.worktree,
              message: "could not switch the branch",
              cause,
            }),
        ),
      )
    })

    const addWorktree = Effect.fn("Repositories.addWorktree")(function* (input: {
      readonly source: AbsolutePath
      readonly directory: AbsolutePath
      readonly branch: string
    }) {
      const source = yield* discover(input.source, "add-worktree")
      const worktree = yield* git.worktree.create({ repository: source, directory: input.directory }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "add-worktree",
              directory: input.directory,
              message: "could not add the worktree",
              cause,
            }),
        ),
      )
      yield* git.sync.checkoutRemoteBranch(worktree, { branch: input.branch }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "add-worktree",
              directory: input.directory,
              message: "could not check out the branch",
              cause,
            }),
        ),
      )
    })

    const removeWorktree = Effect.fn("Repositories.removeWorktree")(function* (input: {
      readonly worktree: AbsolutePath
      readonly force: boolean
    }) {
      const repository = yield* discover(input.worktree, "remove-worktree")
      yield* git.worktree.remove({ repository, directory: input.worktree, force: input.force }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "remove-worktree",
              directory: input.worktree,
              message: "could not remove the worktree",
              cause,
            }),
        ),
      )
    })

    return { inspectCheckout, switchBranch, addWorktree, removeWorktree }
  }),
)
