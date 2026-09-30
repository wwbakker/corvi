/** Checkout work on concrete locations, over the Git adapter.
 *
 * This capability does not know about changes or links: it receives a source, a destination,
 * and a branch. The checkout-method enum and its mapping belong to the caller.
 */
import { Context, Data, Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "./git.ts"
import type { IncomingCommit } from "./git.ts"

export type CheckoutInspection =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Present"; readonly branch?: string; readonly head?: string }

/** One commit the upstream has and the checkout does not. */
export type { IncomingCommit } from "./git.ts"

/** What the checkout and its upstream say about each other: how far they have drifted, where the
 * upstream's tip is, and where the remote lives — the facts an update decides on. */
export type UpstreamFacts = {
  readonly ahead: number
  readonly behind: number
  /** The upstream tip's sha; absent when the branch has no upstream (or its ref is gone). */
  readonly tip?: string
  /** The remote's fetch URL, for building links back to it. */
  readonly remoteUrl?: string
}

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

/** What a fast-forward-only refresh did: moved forward, already current, or left exactly as it
 * was, with git's own reason. */
export type ForwardOutcome =
  | { readonly _tag: "Advanced"; readonly to: string }
  | { readonly _tag: "Current" }
  | { readonly _tag: "LeftAlone"; readonly reason: string }

export class CheckoutError extends Data.TaggedError("CheckoutError")<{
  readonly operation:
    | "inspect"
    | "switch"
    | "add-worktree"
    | "remove-worktree"
    | "fetch"
    | "merge"
    | "pull"
  readonly directory: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface Interface {
  readonly inspectCheckout: (directory: AbsolutePath) => Effect.Effect<CheckoutInspection, CheckoutError>
  /** Fetches the remote, so the upstream facts read after it are current. */
  readonly fetchRemote: (directory: AbsolutePath) => Effect.Effect<void, NotARepository | CheckoutError>
  /** What the checkout and its upstream say about each other (see `UpstreamFacts`). Reads local
   * state only; `fetchRemote` first when the answer must be current. */
  readonly inspectUpstream: (
    directory: AbsolutePath,
  ) => Effect.Effect<UpstreamFacts, NotARepository | CheckoutError>
  /** The commits the upstream has and the checkout does not, newest first. */
  readonly incomingCommits: (
    directory: AbsolutePath,
  ) => Effect.Effect<readonly IncomingCommit[], NotARepository | CheckoutError>
  /** The remote's default branch (its symbolic HEAD, e.g. `main`), from local metadata only;
   * never fetches. Absent when the remote has no symbolic HEAD. */
  readonly defaultRemoteBranch: (
    directory: AbsolutePath,
  ) => Effect.Effect<string | undefined, NotARepository | CheckoutError>
  /** Whether the repository has the named remote (or any remote). The fetch a provisioning run
   * makes is `origin`'s, so that is the name freshness asks about. */
  readonly hasRemote: (
    directory: AbsolutePath,
    remote?: string,
  ) => Effect.Effect<boolean, NotARepository | CheckoutError>
  /** Whether a ref resolves to a commit in the repository — the remote counterpart of a named
   * existing branch, for instance. An unresolvable ref is false, never a failure. */
  readonly refExists: (
    directory: AbsolutePath,
    ref: string,
  ) => Effect.Effect<boolean, NotARepository | CheckoutError>
  /** The base a new branch starts from, and a refresh fast-forwards toward: `origin/<default>`
   * when a remote has one, else a local `main`/`master`; absent when neither exists. */
  readonly defaultBranch: (
    directory: AbsolutePath,
  ) => Effect.Effect<string | undefined, NotARepository | CheckoutError>
  /** Whether the working tree holds staged, modified, untracked, or conflicted entries. */
  readonly workingTreeDirty: (
    directory: AbsolutePath,
  ) => Effect.Effect<boolean, NotARepository | CheckoutError>
  /** Moves the checkout to its upstream's tip exactly when that is a fast-forward. A dirty tree,
   * commits that were never pushed, or diverged histories fail rather than merging or rebasing. */
  readonly pullFastForward: (directory: AbsolutePath) => Effect.Effect<void, NotARepository | CheckoutError>
  /** Moves the checkout to `to` exactly when that is a fast-forward (`git merge --ff-only`).
   * Everything else — own commits, diverged histories, uncommitted work a merge would clobber,
   * a `to` that is not something to merge — is `LeftAlone` with git's own reason, and the
   * checkout is left exactly as it was. A fast-forward that was possible and still failed (an
   * index lock, an I/O problem) is an error, not a refusal: ancestry decides, not the exit code
   * alone. Never a reset, never a rebase. */
  readonly fastForwardBranch: (input: {
    readonly directory: AbsolutePath
    /** What to fast-forward to: the branch's freshness source, chosen by the caller. */
    readonly to: string
  }) => Effect.Effect<ForwardOutcome, NotARepository | CheckoutError>
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
   * is created from `base` (the repository default when absent) — the caller fetches first when
   * that base must be current, which is what the provisioning policy does; without it an
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
   * branch is created from `base` (the caller fetches first when that base must be current);
   * without it the branch — local, or remote-only as a tracking branch — is only switched to. A
   * dirty checkout is left exactly as it is. */
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

    const fetchRemote = Effect.fn("Repositories.fetchRemote")(function* (directory: AbsolutePath) {
      const repository = yield* discover(directory, "fetch")
      // The Git answer is the explanation here ("could not resolve host" and friends), and it is
      // what an update's journal shows — the wrapped message would say only "fetch failed".
      yield* git.sync.fetchRemote(repository).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "fetch",
              directory,
              message: cause.message,
              cause,
            }),
        ),
      )
    })

    const inspectUpstream = Effect.fn("Repositories.inspectUpstream")(function* (directory: AbsolutePath) {
      const repository = yield* discover(directory, "inspect")
      const counts = yield* inspect(git.history.upstream(repository), directory)
      const tip = yield* inspect(git.history.upstreamTip(repository), directory)
      const remoteUrl = yield* inspect(git.repo.remoteUrl(repository), directory)
      return {
        ahead: counts._tag === "Counted" ? counts.ahead : 0,
        behind: counts._tag === "Counted" ? counts.behind : 0,
        ...(tip ? { tip } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
      } satisfies UpstreamFacts
    })

    const incomingCommits = Effect.fn("Repositories.incomingCommits")(function* (directory: AbsolutePath) {
      const repository = yield* discover(directory, "inspect")
      return yield* inspect(git.history.upstreamCommits(repository), directory)
    })

    const defaultRemoteBranch = Effect.fn("Repositories.defaultRemoteBranch")(function* (
      directory: AbsolutePath,
    ) {
      const repository = yield* discover(directory, "inspect")
      return yield* inspect(git.history.defaultRemoteBranch(repository), directory)
    })

    const workingTreeDirty = Effect.fn("Repositories.workingTreeDirty")(function* (directory: AbsolutePath) {
      const repository = yield* discover(directory, "inspect")
      return yield* inspect(git.status.dirty(repository), directory)
    })

    const pullFastForward = Effect.fn("Repositories.pullFastForward")(function* (directory: AbsolutePath) {
      const repository = yield* discover(directory, "pull")
      // As with the fetch above: git's own answer ("Not possible to fast-forward") is what the
      // user needs to read, and the journal is where it lands.
      yield* git.sync.pullFastForward(repository).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "pull",
              directory,
              message: cause.message,
              cause,
            }),
        ),
      )
    })

    const hasRemote = Effect.fn("Repositories.hasRemote")(function* (
      directory: AbsolutePath,
      remote?: string,
    ) {
      const repository = yield* discover(directory, "inspect")
      return yield* inspect(git.repo.hasRemote(repository, remote), directory)
    })

    const refExists = Effect.fn("Repositories.refExists")(function* (
      directory: AbsolutePath,
      ref: string,
    ) {
      const repository = yield* discover(directory, "inspect")
      return yield* inspect(git.history.refExists(repository, ref), directory)
    })

    const defaultBranch = Effect.fn("Repositories.defaultBranch")(function* (directory: AbsolutePath) {
      const repository = yield* discover(directory, "inspect")
      return yield* inspect(git.history.defaultBranch(repository), directory)
    })

    const fastForwardBranch = Effect.fn("Repositories.fastForwardBranch")(function* (input: {
      readonly directory: AbsolutePath
      readonly to: string
    }) {
      const repository = yield* discover(input.directory, "pull")
      const before = yield* inspect(git.history.head(repository), input.directory)
      // Git's own refusal is the explanation here — "Not possible to fast-forward", "not
      // something we can merge", "would be overwritten by merge" — and it is an outcome, not an
      // error: the checkout is left exactly as it was, which is the refresh's whole promise.
      const merged = yield* git.sync.mergeFastForwardOnly(repository, { to: input.to }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation: "merge",
              directory: input.directory,
              message: cause.message,
              cause,
            }),
        ),
        Effect.either,
      )
      if (merged._tag === "Left") {
        // A refusal is an outcome; a fast-forward that was possible and still failed is not.
        // Ancestry decides — with the one exception the promise names: git declines to
        // fast-forward over uncommitted work it would clobber, and that refusal is possible *and*
        // deliberate. A dirty tree is `LeftAlone` with git's verdict; only a clean tree that
        // could have moved and did not is broken infrastructure.
        const possible = yield* git.history
          .isAncestor(repository, { ancestor: before ?? "", descendant: input.to })
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        const dirty = possible
          ? yield* git.status.dirty(repository).pipe(Effect.catchAll(() => Effect.succeed(false)))
          : false
        if (possible && !dirty)
          return yield* new CheckoutError({
            operation: "merge",
            directory: input.directory,
            message: merged.left.message,
            cause: merged.left,
          })
        return { _tag: "LeftAlone", reason: merged.left.message } satisfies ForwardOutcome
      }
      const after = yield* inspect(git.history.head(repository), input.directory)
      return (before === after
        ? { _tag: "Current" }
        : { _tag: "Advanced", to: input.to }) satisfies ForwardOutcome
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
      operation: CheckoutError["operation"] = "inspect",
    ): Effect.Effect<A, CheckoutError> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new CheckoutError({
              operation,
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
      fetchRemote,
      inspectUpstream,
      incomingCommits,
      defaultRemoteBranch,
      hasRemote,
      refExists,
      defaultBranch,
      workingTreeDirty,
      pullFastForward,
      fastForwardBranch,
      assessRemoval,
      removeBranchIfIntegrated,
      provisionLinkedWorktree,
      provisionInPlace,
      removeWorktree,
    }
  }),
)
