# Repository capabilities and change workflows

Status: proposed step-1 design. No workspace packages or production APIs
are implemented. This is the contract specification for the first slice, not another migration
plan; execution remains in the [architecture refactor plan](../plans/architecture-refactor.md).

The sketches below follow the shape of `opencode/packages/core/src/git.ts`: values and errors
first, then the service interface, then the Layer that implements it. They are Effect 3 design
prototypes, not production code. A repository belongs to a change; the workflow reads the change
and the repository links separately and composes them, so neither capability imports the other.

# Change
## Values
```ts
export const ChangeId = Schema.String.pipe(Schema.brand("corvi/ChangeId"))
export type ChangeId = typeof ChangeId.Type

export const ChangePhase = Schema.Literal(
  "Ideation",
  "Implementation",
  "Verification",
  "Blocked",
  "Completed",
  "Cancelled",
)
export type ChangePhase = typeof ChangePhase.Type

export class Change extends Schema.Class<Change>("Change")({
  changeId: ChangeId,
  title: Schema.String,
  workspaceLocation: Schema.String,
  phase: ChangePhase,
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
}) {}

export type ChangeFilter = "Active" | "Archived"

export type CreateChangeInput = {
  readonly changeId: ChangeId
  readonly title: string
  readonly workspaceLocation: string
  readonly phase?: ChangePhase
}
```

## Errors
```ts
export class ChangeNotFound extends Data.TaggedError("ChangeNotFound")<{
  readonly changeId: ChangeId
}> {}

export class ChangeIdTaken extends Data.TaggedError("ChangeIdTaken")<{
  readonly changeId: ChangeId
}> {}

export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly changeId: ChangeId
  readonly from: ChangePhase
  readonly to: ChangePhase
}> {}

export class ChangeConflict extends Data.TaggedError("ChangeConflict")<{
  readonly changeId: ChangeId
  readonly expected: number
  readonly actual: number
}> {}

export class ChangeStoreError extends Data.TaggedError("ChangeStoreError")<{
  readonly changeId: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}
```

## Interface

Allowed transitions:

- `Ideation -> Implementation` is the only way out of `Ideation` (starting the work).
- `Implementation`, `Verification` and `Blocked` may move among themselves.
- `Completed` and `Cancelled` are terminal, set `completedAt`, and are entered by the
  complete/cancel workflows, not by hand.

```ts
export interface Interface {
  readonly getChange: (changeId: ChangeId) => Effect.Effect<Change, ChangeNotFound | ChangeStoreError>
  readonly listChanges: (filter: ChangeFilter) => Effect.Effect<readonly Change[], ChangeStoreError>
  readonly createChange: (input: CreateChangeInput) => Effect.Effect<Change, ChangeIdTaken | ChangeStoreError>
  readonly transitionTo: (
    changeId: ChangeId,
    phase: ChangePhase,
  ) => Effect.Effect<Change, ChangeNotFound | InvalidTransition | ChangeConflict | ChangeStoreError>
}
```

`onPhaseTransition` is deliberately absent: a transition returns the updated change, and the
callable start/complete/cancel workflows decide what follows. The change service does not invoke
repository, terminal or provider behaviour.

## Service and implementation
```ts
export class ChangeService extends Context.Tag("corvi/ChangeService")<ChangeService, Interface>() {}

export const layer = Layer.effect(
  ChangeService,
  Effect.gen(function* () {
    const store = yield* ChangeStore

    const getChange = Effect.fn("Change.getChange")(function* (changeId: ChangeId) {
      const change = yield* store.read(changeId)
      if (!change) return yield* new ChangeNotFound({ changeId })
      return change
    })

    const listChanges = Effect.fn("Change.listChanges")(function* (filter: ChangeFilter) {
      const changes = yield* store.list()
      return changes.filter((change) => (filter === "Archived" ? isFinished(change) : !isFinished(change)))
    })

    const createChange = Effect.fn("Change.createChange")(function* (input: CreateChangeInput) {
      const existing = yield* store.read(input.changeId)
      if (existing) return yield* new ChangeIdTaken({ changeId: input.changeId })
      return yield* store.create(
        new Change({
          changeId: input.changeId,
          title: input.title,
          workspaceLocation: input.workspaceLocation,
          phase: input.phase ?? "Ideation",
          createdAt: now(),
        }),
      )
    })

    const transitionTo = Effect.fn("Change.transitionTo")(function* (
      changeId: ChangeId,
      phase: ChangePhase,
    ) {
      const change = yield* getChange(changeId)
      if (!allowedTransition(change.phase, phase))
        return yield* new InvalidTransition({ changeId, from: change.phase, to: phase })
      // The store applies the patch as one atomic read-modify-write with a revision check;
      // a concurrent writer surfaces as ChangeConflict.
      return yield* store.patch(changeId, {
        phase,
        ...(isTerminal(phase) ? { completedAt: now() } : {}),
      })
    })

    return { getChange, listChanges, createChange, transitionTo }
  }),
)
```

`ChangeStore` is the file-backed store (records, documents, archive location); its consistency
and revision rules are its own contract. `allowedTransition`, `isTerminal` and `isFinished` are
pure rules next to the service.

# Repository (depends on Change)
## Values
```ts
export const RepositoryId = Schema.String.pipe(Schema.brand("corvi/RepositoryId"))
export type RepositoryId = typeof RepositoryId.Type

export const DirectoryName = Schema.String.pipe(Schema.brand("corvi/DirectoryName"))
export type DirectoryName = typeof DirectoryName.Type

export const CheckoutMethod = Schema.Literal(
  "UseOriginalLocationOriginalBranch",
  "UseOriginalLocationNewBranch",
  "UseNewLocationNewBranch",
)
export type CheckoutMethod = typeof CheckoutMethod.Type

export class Repository extends Schema.Class<Repository>("Repository")({
  changeId: ChangeId,
  repositoryId: RepositoryId,
  directoryName: DirectoryName,
  originalLocation: Schema.String,
  checkoutMethod: CheckoutMethod,
}) {}

export type RepositoryState = "Concept" | "Active" | "Archived"

/** The row's state is a projection of the change, not a stored field. */
export const stateOf = (change: Change): RepositoryState =>
  change.phase === "Ideation"
    ? "Concept"
    : change.phase === "Completed" || change.phase === "Cancelled"
      ? "Archived"
      : "Active"

/** New-location checkouts live under the workspace, named after the repository; the two
 * original-location methods keep using the source checkout. */
export const checkoutLocationOf = (workspaceLocation: string, repository: Repository): string =>
  repository.checkoutMethod === "UseNewLocationNewBranch"
    ? join(workspaceLocation, repository.directoryName)
    : repository.originalLocation

export type RepositoryInspection = {
  readonly repository: Repository
  readonly checkoutLocation: string
  readonly checkout:
    | { readonly _tag: "Missing" }
    | { readonly _tag: "Present"; readonly branch?: string; readonly head?: string }
}
```

`stateOf` follows the outline: `Concept` while the change is an idea, `Archived` once the change
is finished, `Active` in between. A per-link "checkout applied" fact is not part of this version;
if start can fail for one repository and succeed for another, that fact is what will say so.
`checkoutLocationOf` returns the source path for the two original-location methods and the
workspace path for new-location ones.

## Errors
```ts
export class RepositoryNotFound extends Data.TaggedError("RepositoryNotFound")<{
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
}> {}

export class DuplicateDirectoryName extends Data.TaggedError("DuplicateDirectoryName")<{
  readonly changeId: ChangeId
  readonly directoryName: DirectoryName
}> {}

export class SourceNotARepository extends Data.TaggedError("SourceNotARepository")<{
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
  readonly originalLocation: string
}> {}

export class CheckoutError extends Data.TaggedError("CheckoutError")<{
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
  readonly message: string
  readonly cause?: unknown
}> {}

export class CheckoutInspectionFailed extends Data.TaggedError("CheckoutInspectionFailed")<{
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
  readonly checkoutLocation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class RepositoryStoreError extends Data.TaggedError("RepositoryStoreError")<{
  readonly changeId: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}
```

## Interface
```ts
export type AddRepositoryInput = {
  readonly changeId: ChangeId
  readonly directoryName: DirectoryName
  readonly originalLocation: string
  readonly checkoutMethod: CheckoutMethod
}

export type RepositoryRef = {
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
}

export type ProvisionRepositoryInput = RepositoryRef & {
  /** Supplied by the start workflow, usually the change id; used by the new-branch methods. */
  readonly branch: string
}

export type ProvisionError = RepositoryNotFound | SourceNotARepository | CheckoutError | RepositoryStoreError

export interface Interface {
  readonly listRepositories: (changeId: ChangeId) => Effect.Effect<readonly Repository[], RepositoryStoreError>
  readonly addRepository: (input: AddRepositoryInput) => Effect.Effect<Repository, DuplicateDirectoryName | RepositoryStoreError>
  /** Applies the checkout method: the step that turns a concept link into a real checkout. */
  readonly provisionRepository: (input: ProvisionRepositoryInput) => Effect.Effect<Repository, ProvisionError>
  /** Reads the recorded checkout's current facts; absence is a value, not an error. */
  readonly inspectRepository: (
    input: RepositoryRef,
  ) => Effect.Effect<RepositoryInspection, RepositoryNotFound | CheckoutInspectionFailed | RepositoryStoreError>
  readonly removeRepository: (input: RepositoryRef) => Effect.Effect<void, RepositoryNotFound | RepositoryStoreError>
}
```

`removeRepository` removes the link, not a checkout: deleting an owned worktree stays an explicit
completion step with its own safety assessment.

## Service and implementation
```ts
export class RepositoryService extends Context.Tag("corvi/RepositoryService")<RepositoryService, Interface>() {}

export const layer = (options: { readonly workspaceLocation: string }) =>
  Layer.effect(
    RepositoryService,
    Effect.gen(function* () {
      const git = yield* Git.Service
      const store = yield* RepositoryStore

      const listRepositories = Effect.fn("Repository.listRepositories")(function* (changeId: ChangeId) {
        return yield* store.list(changeId)
      })

      const addRepository = Effect.fn("Repository.addRepository")(function* (input: AddRepositoryInput) {
        const existing = yield* store.list(input.changeId)
        if (existing.some((repository) => repository.directoryName === input.directoryName))
          return yield* new DuplicateDirectoryName({
            changeId: input.changeId,
            directoryName: input.directoryName,
          })
        // RepositoryStore assigns repositoryId.
        return yield* store.add(input)
      })

      const provisionRepository = Effect.fn("Repository.provisionRepository")(function* (
        input: ProvisionRepositoryInput,
      ) {
        const repository = yield* store.read(input.changeId, input.repositoryId)
        if (!repository) return yield* new RepositoryNotFound(input)

        const source = yield* git.repo.discover(repository.originalLocation)
        if (!source)
          return yield* new SourceNotARepository({
            changeId: input.changeId,
            repositoryId: input.repositoryId,
            originalLocation: repository.originalLocation,
          })

        const checkoutLocation = checkoutLocationOf(options.workspaceLocation, repository)
        switch (repository.checkoutMethod) {
          case "UseOriginalLocationOriginalBranch":
            // The original checkout is what the change wants; there is nothing to switch.
            break
          case "UseOriginalLocationNewBranch":
            yield* git.sync.checkoutRemoteBranch(source, { branch: input.branch })
            break
          case "UseNewLocationNewBranch": {
            const worktree = yield* git.worktree.create({
              repository: source,
              directory: AbsolutePath.make(checkoutLocation),
            })
            yield* git.sync.checkoutRemoteBranch(worktree, { branch: input.branch })
            break
          }
        }
        return repository
      })

      const inspectRepository = Effect.fn("Repository.inspectRepository")(function* (input: RepositoryRef) {
        const repository = yield* store.read(input.changeId, input.repositoryId)
        if (!repository) return yield* new RepositoryNotFound(input)

        const checkoutLocation = checkoutLocationOf(options.workspaceLocation, repository)
        const checkout = yield* git.repo.discover(AbsolutePath.make(checkoutLocation))
        if (!checkout)
          return { repository, checkoutLocation, checkout: { _tag: "Missing" } } satisfies RepositoryInspection

        const branch = yield* git.history.branch(checkout)
        const head = yield* git.history.head(checkout)
        return {
          repository,
          checkoutLocation,
          checkout: { _tag: "Present", branch, head },
        } satisfies RepositoryInspection
      })

      const removeRepository = Effect.fn("Repository.removeRepository")(function* (input: RepositoryRef) {
        const repository = yield* store.read(input.changeId, input.repositoryId)
        if (!repository) return yield* new RepositoryNotFound(input)
        yield* store.remove(input.changeId, input.repositoryId)
      })

      return { listRepositories, addRepository, provisionRepository, inspectRepository, removeRepository }
    }),
  )
```

Git failures are mapped to `CheckoutError` at this boundary; `RepositoryStore` keeps the links.
The layer is workspace-scoped because `checkoutLocation` needs the workspace root — composition
supplies it, so `repositories` still imports only contracts. `inspectRepository` reports
`Missing` when no repository is found at the recorded checkout location; the first slice does
not yet tell an absent directory from a replaced one.

# Git (dependency)

All Git work goes through this service (owned by `repositories`, supplied by composition). The
first slice needs this subset; the names and shapes follow `opencode/packages/core/src/git.ts`:

```ts
export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: "discover" | "checkout" | "create" | "remove" | "list"
  readonly message: string
  readonly directory?: string
  readonly cause?: unknown
}> {}

export interface Interface {
  readonly repo: {
    readonly discover: (directory: AbsolutePath) => Effect.Effect<Repository | undefined>
  }
  readonly history: {
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined>
    readonly head: (repository: Repository) => Effect.Effect<string | undefined>
  }
  readonly sync: {
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) => Effect.Effect<void, GitError>
  }
  readonly worktree: {
    readonly create: (input: { repository: Repository; directory: AbsolutePath }) => Effect.Effect<Repository, GitError>
    readonly remove: (input: { repository: Repository; directory: AbsolutePath; force: boolean }) => Effect.Effect<void, GitError>
    readonly list: (repository: Repository) => Effect.Effect<readonly { directory: AbsolutePath; kind: "main" | "linked" }[], GitError>
  }
}

export class GitService extends Context.Tag("corvi/GitService")<GitService, Interface>() {}
```

The identity `{ worktree, gitDirectory, commonDirectory }` is what makes linked worktrees
comparable; `commonDirectory` is the repository identity. The opencode implementation targets
Effect 4 beta (`effect/unstable/process`, `Schema.TaggedErrorClass`), so the operations are
ported to Effect 3 rather than imported.

# Workflows

The first slice has two callable operations: one read for the dashboard and one write for
starting work. They live in `workflows`, take their dependencies from context, and are ordinary
Effect programs — no engine, no event handlers, no HTTP. A route, a test, and a future status
action call the same operation.

## Values
```ts
export type RepositoryView = {
  readonly repository: Repository
  readonly state: RepositoryState
  readonly checkoutLocation: string
  readonly checkout: RepositoryInspection["checkout"]
}

export type ProvisionFailure = {
  readonly repositoryId: RepositoryId
  readonly error: ProvisionError
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
```

## Progress port
```ts
export interface ProgressInterface {
  readonly record: (input: {
    readonly changeId: ChangeId
    readonly step: OperationStep
  }) => Effect.Effect<void, ChangeStoreError>
}

export class OperationProgress extends Context.Tag("corvi/OperationProgress")<
  OperationProgress,
  ProgressInterface
>() {}
```

The port is backed by the change's operation document in the first slice: a half started change
has to stay legible from a page that was never open. `PartiallyStarted` is an outcome, not an
error — the failed repository stays visible instead of being lost.

## Interface
```ts
export interface Interface {
  readonly inspectChangeRepositories: (
    changeId: ChangeId,
  ) => Effect.Effect<
    readonly RepositoryView[],
    ChangeNotFound | ChangeStoreError | RepositoryStoreError | CheckoutInspectionFailed
  >
  readonly startChange: (
    changeId: ChangeId,
  ) => Effect.Effect<StartOutcome, ChangeNotFound | InvalidTransition | ChangeConflict | ChangeStoreError>
}
```

## Service and implementation
```ts
export class ChangeWork extends Context.Tag("corvi/ChangeWork")<ChangeWork, Interface>() {}

export const layer = Layer.effect(
  ChangeWork,
  Effect.gen(function* () {
    const changes = yield* ChangeService
    const repositories = yield* RepositoryService
    const progress = yield* OperationProgress

    const inspectChangeRepositories = Effect.fn("ChangeWork.inspectChangeRepositories")(function* (
      changeId: ChangeId,
    ) {
      const change = yield* changes.getChange(changeId)
      const links = yield* repositories.listRepositories(changeId)
      return yield* Effect.forEach(
        links,
        (repository) =>
          repositories
            .inspectRepository({ changeId, repositoryId: repository.repositoryId })
            .pipe(
              Effect.map(
                (inspection): RepositoryView => ({
                  repository: inspection.repository,
                  state: stateOf(change),
                  checkoutLocation: inspection.checkoutLocation,
                  checkout: inspection.checkout,
                }),
              ),
            ),
        { concurrency: 4 },
      )
    })

    const startChange = Effect.fn("ChangeWork.startChange")(function* (changeId: ChangeId) {
      const change = yield* changes.getChange(changeId)
      if (change.phase !== "Ideation")
        return yield* new InvalidTransition({ changeId, from: change.phase, to: "Implementation" })

      // Persist first: the change survives provisioning that fails part way.
      const started = yield* changes.transitionTo(changeId, "Implementation")

      const links = yield* repositories.listRepositories(changeId)
      const provisioned: Repository[] = []
      const failures: ProvisionFailure[] = []
      for (const link of links) {
        const label = `checkout ${link.directoryName}`
        yield* progress.record({ changeId, step: { id: link.repositoryId, label, state: "running" } })
        const attempt = yield* repositories
          // The branch defaults to the change id until Change carries a branch field.
          .provisionRepository({ changeId, repositoryId: link.repositoryId, branch: started.changeId })
          .pipe(Effect.either)
        if (attempt._tag === "Right") {
          provisioned.push(attempt.right)
          yield* progress.record({ changeId, step: { id: link.repositoryId, label, state: "done" } })
        } else {
          failures.push({ repositoryId: link.repositoryId, error: attempt.left })
          yield* progress.record({
            changeId,
            step: {
              id: link.repositoryId,
              label,
              state: "failed",
              detail: describeProvisionError(attempt.left),
            },
          })
        }
      }

      if (failures.length > 0)
        return { _tag: "PartiallyStarted", change: started, repositories: provisioned, failures }
      return { _tag: "Started", change: started, repositories: provisioned }
    })

    return { inspectChangeRepositories, startChange }
  }),
)
```

`startChange` persists `Implementation` before provisioning and continues past a failed
repository, so the result is either `Started` or `PartiallyStarted` with a journal entry per
repository. `describeProvisionError` maps the typed union to the short line the journal shows.
