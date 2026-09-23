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

/** One thing a removal would destroy, and the facts it was observed from. */
export type RemovalReason = {
  readonly code: "dirty-worktree" | "unpushed"
  readonly kind: "hard" | "forceable"
  readonly text: string
  readonly facts: string
}

export type RemovalAssessment =
  | { readonly _tag: "Safe" }
  | { readonly _tag: "NeedsAcknowledgement"; readonly reasons: readonly RemovalReason[] }
  | { readonly _tag: "Unsafe"; readonly reasons: readonly RemovalReason[] }

/** What happened to the branch after a checkout was removed. */
export type BranchCleanup = "deleted" | "kept" | "absent"

/** What provisioning an in-place checkout did, including the dirty case it leaves alone. */
export type InPlaceOutcome = "already" | "switched" | "created" | "skipped-dirty"

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
  /** Whether removing this checkout would destroy anything: uncommitted work refuses outright;
   * commits the base cannot prove it has are acknowledged first. */
  readonly assessRemoval: (input: {
    readonly worktree: AbsolutePath
    /** The branch the change put there; absent for a detached checkout. */
    readonly branch?: string
  }) => Effect.Effect<RemovalAssessment, NotARepository | CheckoutError>
  /** After a checkout is gone: delete the branch when the base proves its content landed,
   * report it kept when it remains, or absent when it never existed. A branch that refuses
   * deletion is reported kept, not failed: the removal already happened. */
  readonly removeBranchIfIntegrated: (input: {
    readonly repository: AbsolutePath
    readonly branch: string
  }) => Effect.Effect<BranchCleanup, NotARepository | CheckoutError>
  /** Creates the linked worktree the change asked for. With `createMissing`, a missing branch
   * is created from `base` (the repository default when absent) after a fetch; without it an
   * existing branch is attached — local, or remote-only as a tracking branch — and a name that
   * exists nowhere is an error rather than silently created. */
  readonly provisionLinkedWorktree: (input: {
    readonly source: AbsolutePath
    readonly directory: AbsolutePath
    readonly branch: string
    readonly base?: string
    readonly createMissing: boolean
  }) => Effect.Effect<void, NotARepository | CheckoutError>
  /** Switches the source checkout itself to the given branch. With `createMissing`, a missing
   * branch is created from `base`; without it the branch — local, or remote-only as a tracking
   * branch — is only switched to. A dirty checkout is left exactly as it is. */
  readonly provisionInPlace: (input: {
    readonly source: AbsolutePath
    readonly branch: string
    readonly base?: string
    readonly createMissing: boolean
  }) => Effect.Effect<InPlaceOutcome, NotARepository | CheckoutError>
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

    const inspect = <A>(
      effect: Effect.Effect<A, Git.OperationError>,
      directory: AbsolutePath,
    ): Effect.Effect<A, CheckoutError> =>
      effect.pipe(
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

    const assessRemoval = Effect.fn("Repositories.assessRemoval")(function* (input: {
      readonly worktree: AbsolutePath
      readonly branch?: string
    }) {
      const repository = yield* discover(input.worktree, "inspect")
      const head = yield* inspect(git.history.head(repository), input.worktree)
      const dirty = yield* inspect(git.status.dirty(repository), input.worktree)
      if (dirty)
        return {
          _tag: "Unsafe",
          reasons: [
            {
              code: "dirty-worktree",
              kind: "hard",
              text: "uncommitted changes",
              facts: `dirty:${head ?? "unborn"}`,
            },
          ],
        } satisfies RemovalAssessment

      const base = yield* inspect(git.history.defaultRemoteBranch(repository), input.worktree)
      const proven = (branch: string): Effect.Effect<boolean, CheckoutError> =>
        base
          ? inspect(git.integration.proven(repository, { branch, base }), input.worktree)
          : Effect.succeed(false)

      if (!input.branch)
        return {
          _tag: "NeedsAcknowledgement",
          reasons: [
            {
              code: "unpushed",
              kind: "forceable",
              text: "a detached checkout",
              facts: `detached:${head ?? "unborn"}`,
            },
          ],
        } satisfies RemovalAssessment

      const upstream = yield* inspect(git.history.upstream(repository), input.worktree)
      if (upstream._tag === "Counted" && upstream.ahead > 0) {
        if (yield* proven(input.branch)) return { _tag: "Safe" } satisfies RemovalAssessment
        return {
          _tag: "NeedsAcknowledgement",
          reasons: [
            {
              code: "unpushed",
              kind: "forceable",
              text: `${upstream.ahead} unpushed commit(s)`,
              facts: `unpushed:${head ?? "unborn"}:${upstream.ahead}`,
            },
          ],
        } satisfies RemovalAssessment
      }
      if (upstream._tag === "Counted") return { _tag: "Safe" } satisfies RemovalAssessment
      if (yield* proven(input.branch)) return { _tag: "Safe" } satisfies RemovalAssessment
      return {
        _tag: "NeedsAcknowledgement",
        reasons: [
          {
            code: "unpushed",
            kind: "forceable",
            text:
              upstream._tag === "Unavailable"
                ? "the upstream comparison is unavailable"
                : "commits that were never pushed",
            facts: `unpushed:${head ?? "unborn"}:none`,
          },
        ],
      } satisfies RemovalAssessment
    })

    const removeBranchIfIntegrated = Effect.fn("Repositories.removeBranchIfIntegrated")(function* (input: {
      readonly repository: AbsolutePath
      readonly branch: string
    }) {
      const repository = yield* discover(input.repository, "remove-worktree")
      const exists = (): Effect.Effect<boolean, CheckoutError> =>
        inspect(git.history.branchExists(repository, input.branch), input.repository)
      const base = yield* inspect(git.history.defaultRemoteBranch(repository), input.repository)
      const integrated = base
        ? yield* inspect(git.integration.proven(repository, { branch: input.branch, base }), input.repository)
        : false
      if (integrated) {
        const deleted = yield* git.sync.deleteBranch(repository, input.branch).pipe(Effect.either)
        if (deleted._tag === "Right") return "deleted" as const
        return (yield* exists()) ? ("kept" as const) : ("absent" as const)
      }
      return (yield* exists()) ? ("kept" as const) : ("absent" as const)
    })

    const provisionLinkedWorktree = Effect.fn("Repositories.provisionLinkedWorktree")(function* (input: {
      readonly source: AbsolutePath
      readonly directory: AbsolutePath
      readonly branch: string
      readonly base?: string
      readonly createMissing: boolean
    }) {
      const repository = yield* discover(input.source, "add-worktree")
      // A checkout already at the destination is the state this wanted.
      const existing = yield* inspect(git.repo.discover(input.directory), input.source)
      if (existing) return
      // An existing branch is only ever attached: `git worktree add` attaches a local branch, or
      // creates a tracking branch for a remote-only name, and refuses a name that is nowhere.
      const attachable =
        !input.createMissing || (yield* inspect(git.history.branchExists(repository, input.branch), input.source))
      if (attachable) {
        yield* inspect(
          git.worktree.add({
            repository,
            directory: input.directory,
            branch: input.branch,
            create: false,
          }),
          input.source,
        )
        return
      }
      const base =
        input.base ?? (yield* inspect(git.history.defaultBranch(repository), input.source))
      if (yield* inspect(git.repo.hasRemote(repository), input.source))
        yield* inspect(git.sync.fetchRemote(repository), input.source).pipe(Effect.either)
      yield* inspect(
        git.worktree.add({
          repository,
          directory: input.directory,
          branch: input.branch,
          create: true,
          ...(base ? { base } : {}),
        }),
        input.source,
      )
    })

    const provisionInPlace = Effect.fn("Repositories.provisionInPlace")(function* (input: {
      readonly source: AbsolutePath
      readonly branch: string
      readonly base?: string
      readonly createMissing: boolean
    }) {
      const repository = yield* discover(input.source, "switch")
      const current = yield* inspect(git.history.branch(repository), input.source)
      if (current === input.branch) return "already" as const
      if (yield* inspect(git.status.dirty(repository), input.source)) return "skipped-dirty" as const
      if (!input.createMissing) {
        // Attach-only: `git switch` moves to a local branch, or creates a tracking branch for a
        // remote-only name, and refuses a name that is nowhere.
        yield* inspect(git.sync.switchToBranch(repository, { branch: input.branch }), input.source)
        return "switched" as const
      }
      const exists = yield* inspect(git.history.branchExists(repository, input.branch), input.source)
      if (exists) {
        yield* inspect(git.sync.switchToBranch(repository, { branch: input.branch }), input.source)
        return "switched" as const
      }
      const base =
        input.base ?? (yield* inspect(git.history.defaultBranch(repository), input.source))
      if (yield* inspect(git.repo.hasRemote(repository), input.source))
        yield* inspect(git.sync.fetchRemote(repository), input.source).pipe(Effect.either)
      yield* inspect(
        git.sync.switchToBranch(repository, {
          branch: input.branch,
          create: true,
          ...(base ? { base } : {}),
        }),
        input.source,
      )
      return "created" as const
    })

    return {
      inspectCheckout,
      assessRemoval,
      removeBranchIfIntegrated,
      provisionLinkedWorktree,
      provisionInPlace,
      switchBranch,
      addWorktree,
      removeWorktree,
    }
  }),
)
