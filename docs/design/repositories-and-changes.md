# Repository capabilities and change workflows

Status: proposed step-1 design. No workspace packages or production APIs
are implemented. This is the contract specification for the first slice, not another migration
plan; execution remains in the [architecture refactor plan](../plans/architecture-refactor.md).

The sketches below follow the shape of `opencode/packages/core/src/git.ts`: values and errors
first, then the service interface, then the Layer that implements it. They are Effect 3 design
prototypes, not production code. The same contracts live as typechecked prototypes in
`docs/design/repositories-and-changes/`; `bun run typecheck` checks them and no application code
imports them.

A change owns its repository links, and the `repositories` capability performs checkout work on
concrete locations. The workflow reads the change and its links and calls checkouts with concrete
inputs, so neither capability imports the other. The first slice is the dashboard read
(`inspectChangeRepositories`) and starting work (`startChange`); completion, cancellation,
terminals and agents are later slices.

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
  /** The branch the change's checkouts use; defaults to the change id. */
  branch: Schema.String,
  phase: ChangePhase,
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
}) {}

export type ChangeFilter = "Active" | "Archived"

export type CreateChangeInput = {
  readonly changeId: ChangeId
  readonly title: string
  readonly workspaceLocation: string
  /** Defaults to the change id. */
  readonly branch?: string
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
          branch: input.branch ?? input.changeId,
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

`ChangeStore` is the file-backed store (records, documents, archive location, repository links);
its consistency and revision rules are its own contract. `allowedTransition`, `isTerminal` and
`isFinished` are pure rules next to the service.

# Change repositories

A repository link belongs to a change: which source it touches, the name it is filed under, and
the checkout method chosen for it. The `changes` capability owns this data and performs no Git
work. `stateOf` and `checkoutLocationOf` are pure projections over the change and its links.

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
export const checkoutLocationOf = (change: Change, repository: Repository): string =>
  repository.checkoutMethod === "UseNewLocationNewBranch"
    ? join(change.workspaceLocation, repository.directoryName)
    : repository.originalLocation

export type RepositoryRef = {
  readonly changeId: ChangeId
  readonly repositoryId: RepositoryId
}

export type AddRepositoryInput = {
  readonly changeId: ChangeId
  readonly directoryName: DirectoryName
  readonly originalLocation: string
  readonly checkoutMethod: CheckoutMethod
}
```

`stateOf` follows the outline: `Concept` while the change is an idea, `Archived` once the change
is finished, `Active` in between. There is no stored "checkout applied" fact: a link that failed
to provision still reads `Active`, and what says otherwise is the `Missing` checkout from
inspection plus the operation journal.

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

export class RepositoryStoreError extends Data.TaggedError("RepositoryStoreError")<{
  readonly changeId: ChangeId
  readonly operation: "read" | "write"
  readonly message: string
  readonly cause?: unknown
}> {}
```

## Interface
```ts
export interface Interface {
  readonly listRepositories: (changeId: ChangeId) => Effect.Effect<readonly Repository[], RepositoryStoreError>
  readonly addRepository: (
    input: AddRepositoryInput,
  ) => Effect.Effect<Repository, DuplicateDirectoryName | RepositoryStoreError>
  /** Removes the link; deleting an owned checkout is a completion step, not a link edit. */
  readonly removeRepository: (input: RepositoryRef) => Effect.Effect<void, RepositoryNotFound | RepositoryStoreError>
}
```

## Service and implementation
```ts
export class ChangeRepositories extends Context.Tag("corvi/ChangeRepositories")<ChangeRepositories, Interface>() {}

export const layer = Layer.effect(
  ChangeRepositories,
  Effect.gen(function* () {
    const store = yield* ChangeStore

    const listRepositories = Effect.fn("ChangeRepositories.listRepositories")(function* (changeId: ChangeId) {
      return yield* store.listRepositories(changeId)
    })

    const addRepository = Effect.fn("ChangeRepositories.addRepository")(function* (input: AddRepositoryInput) {
      const existing = yield* store.listRepositories(input.changeId)
      if (existing.some((repository) => repository.directoryName === input.directoryName))
        return yield* new DuplicateDirectoryName({
          changeId: input.changeId,
          directoryName: input.directoryName,
        })
      // ChangeStore assigns repositoryId and persists the link with the change.
      return yield* store.addRepository(input)
    })

    const removeRepository = Effect.fn("ChangeRepositories.removeRepository")(function* (input: RepositoryRef) {
      const removed = yield* store.removeRepository(input.changeId, input.repositoryId)
      if (!removed) return yield* new RepositoryNotFound(input)
    })

    return { listRepositories, addRepository, removeRepository }
  }),
)
```

# Repositories (Git)

The `repositories` capability performs checkout work on concrete locations. It does not know about
changes or links: it receives a source, a destination, and a branch. All Git access goes through
the `Git` adapter below, which stays private to this package.

## Values
```ts
export type CheckoutInspection =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Present"; readonly branch?: string; readonly head?: string }
```

## Errors
```ts
export class NotARepository extends Data.TaggedError("NotARepository")<{
  readonly directory: string
}> {}

export class CheckoutError extends Data.TaggedError("CheckoutError")<{
  readonly operation: "inspect" | "switch" | "add-worktree" | "remove-worktree"
  readonly directory: string
  readonly message: string
  readonly cause?: unknown
}> {}
```

## Interface
```ts
export interface Interface {
  /** Reads the recorded location; absence is a value, unreadable is an error. */
  readonly inspectCheckout: (directory: AbsolutePath) => Effect.Effect<CheckoutInspection, CheckoutError>
  /** Switches an existing checkout to the branch (the original-location-new-branch method). */
  readonly switchBranch: (input: {
    readonly worktree: AbsolutePath
    readonly branch: string
  }) => Effect.Effect<void, NotARepository | CheckoutError>
  /** Adds a linked worktree and checks out the branch (the new-location method). */
  readonly addWorktree: (input: {
    readonly source: AbsolutePath
    readonly directory: AbsolutePath
    readonly branch: string
  }) => Effect.Effect<void, NotARepository | CheckoutError>
  /** Removes a linked worktree. No first-slice workflow calls this. */
  readonly removeWorktree: (input: {
    readonly worktree: AbsolutePath
    readonly force: boolean
  }) => Effect.Effect<void, NotARepository | CheckoutError>
}
```

The checkout-method enum is application policy and stays in `changes`; mapping
`UseOriginalLocation*` to `switchBranch`, and `UseNewLocation*` to `addWorktree`, happens in the
workflow. The capability only knows concrete sources and destinations.

## Service and implementation
```ts
export class Repositories extends Context.Tag("corvi/Repositories")<Repositories, Interface>() {}

export const layer = Layer.effect(
  Repositories,
  Effect.gen(function* () {
    const git = yield* Git.Service

    const discover = Effect.fnUntraced(function* (directory: AbsolutePath) {
      const repository = yield* git.repo.discover(directory)
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
      const branch = yield* git.history.branch(repository)
      const head = yield* git.history.head(repository)
      return { _tag: "Present", branch, head } satisfies CheckoutInspection
    })

    const switchBranch = Effect.fn("Repositories.switchBranch")(function* (input: {
      readonly worktree: AbsolutePath
      readonly branch: string
    }) {
      const repository = yield* discover(input.worktree)
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
      const source = yield* discover(input.source)
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
      const repository = yield* discover(input.worktree)
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
```

`inspectCheckout` returns `Missing` when `discover` finds no repository at the recorded location;
the first slice does not yet tell an absent directory from a replaced one. Git failures are errors,
not `Missing`.

# Git (adapter)

The `Git` adapter is private to `repositories`; composition supplies it. The first slice needs this
subset; the names and shapes follow `opencode/packages/core/src/git.ts`:

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
    readonly discover: (directory: AbsolutePath) => Effect.Effect<Repository | undefined, GitError>
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
comparable; `commonDirectory` is the repository identity. `discover` keeps an error channel so a
failed read is not mistaken for absence (the opencode version currently swallows it). The opencode
implementation targets Effect 4 beta (`effect/unstable/process`, `Schema.TaggedErrorClass`), so
the operations are ported to Effect 3 rather than imported.

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
```

## Progress port
```ts
export interface ProgressInterface {
  readonly record: (input: {
    readonly changeId: ChangeId
    readonly step: OperationStep
  }) => Effect.Effect<void, ChangeStoreError>
}

export class OperationProgress extends Context.Tag("corvi/OperationProgress")<OperationProgress, ProgressInterface>() {}
```

The port is backed by a change-owned operation record: steps are written atomically beside the
change's data, not into `PLAN.md` or notes, and the record is versioned like the rest of the
persisted change. A half started change has to stay legible from a page that was never open, and
completion will use the same record. `PartiallyStarted` is an outcome, not an error — the failed
repository stays visible instead of being lost.

## Interface
```ts
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
```

## Service and implementation
```ts
export class ChangeWork extends Context.Tag("corvi/ChangeWork")<ChangeWork, Interface>() {}

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

    // The checkout policy belongs to the application, so the enum-to-operation mapping is here.
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
        return { _tag: "PartiallyStarted", change: started, repositories: provisioned, failures }
      return { _tag: "Started", change: started, repositories: provisioned }
    })

    return { inspectChangeRepositories, startChange }
  }),
)
```

`startChange` persists `Implementation` before provisioning and continues past a failed repository,
so the result is either `Started` or `PartiallyStarted` with a journal entry per repository.
`describeProvisionError` maps the typed union to the short line the journal shows.

# API (transport boundary)

The dashboard reads one change's repositories. The route decodes the path, calls the workflow, and
encodes the view; the client exposes a named method that returns the same decoded shape. Both
import the schema below; there is no caller-selected response generic.

## Contract
```ts
export const RepositoryViewSchema = Schema.Struct({
  repositoryId: RepositoryId,
  directoryName: DirectoryName,
  state: Schema.Literal("Concept", "Active", "Archived"),
  checkoutLocation: Schema.String,
  checkout: Schema.Union(
    Schema.Struct({ _tag: Schema.Literal("Missing") }),
    Schema.Struct({
      _tag: Schema.Literal("Present"),
      branch: Schema.optional(Schema.String),
      head: Schema.optional(Schema.String),
    }),
  ),
})
export type RepositoryViewDto = typeof RepositoryViewSchema.Type

export const endpoint = "GET /api/changes/:changeId/repositories" as const
```

## Server route
```ts
// apps/server — transport adapter: decode, invoke, encode
export const inspectChangeRepositoriesRoute = (request: {
  readonly params: { readonly changeId: string }
}): Effect.Effect<readonly RepositoryViewDto[], HttpError, ChangeWork> =>
  Effect.gen(function* () {
    const changeId = yield* decode(ChangeId, request.params.changeId) // untrusted path input
    const work = yield* ChangeWork
    const views = yield* work.inspectChangeRepositories(changeId)
    return views.map(toDto)
  }).pipe(
    Effect.catchTags({
      ChangeNotFound: () => new HttpError({ status: 404, message: "change not found" }),
      ChangeStoreError: (error) => new HttpError({ status: 500, message: error.message }),
      RepositoryStoreError: (error) => new HttpError({ status: 500, message: error.message }),
      CheckoutError: (error) => new HttpError({ status: 500, message: error.message }),
    }),
  )
```

## Client
```ts
// client — Promise-facing for React
export interface ChangesClient {
  readonly inspectRepositories: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
}

export const makeChangesClient = (baseUrl: string): ChangesClient => ({
  inspectRepositories: async (changeId) => {
    const response = await fetch(`${baseUrl}/api/changes/${encodeURIComponent(changeId)}/repositories`)
    if (!response.ok) throw await decodeFailure(response)
    return Schema.decodeUnknownSync(Schema.Array(RepositoryViewSchema))(await response.json())
  },
})
```

Domain failures map to transport status here and nowhere else; the workflow and capability errors
stay typed. The client throws a classified failure rather than a bare `Error`.

## Start endpoint

`startChange` is the first write operation. Same shape: one schema, one route, one named client
method.

```ts
export const ProvisionFailureSchema = Schema.Struct({
  repositoryId: RepositoryId,
  code: Schema.Literal("not-a-repository", "checkout-failed"),
  message: Schema.String,
})

export const StartOutcomeSchema = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Started"),
    change: Change,
    repositoryIds: Schema.Array(RepositoryId),
  }),
  Schema.Struct({
    _tag: Schema.Literal("PartiallyStarted"),
    change: Change,
    repositoryIds: Schema.Array(RepositoryId),
    failures: Schema.Array(ProvisionFailureSchema),
  }),
)
export type StartOutcomeDto = typeof StartOutcomeSchema.Type

export const startEndpoint = "POST /api/changes/:changeId/start" as const
```

```ts
// apps/server — transport adapter: decode, invoke, encode
export const startChangeRoute = (request: {
  readonly params: { readonly changeId: string }
}): Effect.Effect<StartOutcomeDto, HttpError, ChangeWork> =>
  Effect.gen(function* () {
    const changeId = yield* decode(ChangeId, request.params.changeId)
    const work = yield* ChangeWork
    return toStartOutcomeDto(yield* work.startChange(changeId))
  }).pipe(
    Effect.catchTags({
      ChangeNotFound: () => new HttpError({ status: 404, message: "change not found" }),
      InvalidTransition: () => new HttpError({ status: 409, message: "change is not an idea" }),
      ChangeConflict: () => new HttpError({ status: 409, message: "change changed; retry" }),
      ChangeStoreError: (error) => new HttpError({ status: 500, message: error.message }),
      RepositoryStoreError: (error) => new HttpError({ status: 500, message: error.message }),
    }),
  )
```

```ts
// client — Promise-facing for React
export interface ChangesClient {
  readonly inspectRepositories: (changeId: ChangeId) => Promise<readonly RepositoryViewDto[]>
  readonly startChange: (changeId: ChangeId) => Promise<StartOutcomeDto>
}
```

`PartiallyStarted` is a 200: it is a business outcome, not a transport failure. The response
carries repository ids and failures; the client refetches the read endpoint for rows. The journal
is durable, so a reload can read what happened; streaming those steps live needs replay and
cancellation semantics and is not part of this slice. There is no retry in this slice: a partial
start stays visible as `PartiallyStarted`, `Missing` rows, and the journal.

# Behavior tests

## Layers

| Layer | Supply | Assert |
| --- | --- | --- |
| Pure rules | nothing | allowed transitions, `stateOf`, `checkoutLocationOf`, `isFinished`, duplicate directory names |
| Workflow | scripted `ChangeService`, `ChangeRepositories`, `Repositories`, `OperationProgress` | persist-first ordering, one journal entry per repository, `PartiallyStarted` with a scripted failure, checkout-method mapping, no provisioning outside `Ideation` |
| Links capability | real change store in isolated paths | add/list/remove links, duplicate rejection, links survive reload, remove touches no Git |
| Checkout capability | scripted `Git` | `Missing` vs `CheckoutError`, `NotARepository` for a non-repository source, inspect performs no mutation |
| Git adapter | real fixture repositories | identity via `commonDirectory` across linked worktrees, worktree create/remove/list, branch checkout, unborn/detached HEAD, paths with spaces |
| Transport/client | route and client against the same schema | path decoding, one status per error tag, client decodes the server payload, malformed input rejected |

Scripted fakes fail on an unscripted operation; they never fall back to live I/O. Workflow tests
run Effects directly and use Deferred/events instead of sleeps.

## Existing coverage to preserve

| Current tests | Behavior to keep after retargeting |
| --- | --- |
| `changes`, `ideation`, `repos`, `provision`, `tooling` | idea vs started change, branch/base selection, in-place protection, archive readability |
| `complete`, `cancel`, `lifecycle`, `lifecycleFailures` | fresh checks, ordered steps, acknowledgement, dirty-work refusal, partial-failure reporting |
| `review`, `cards`, `github`, `githubChecks`, `jira*`, `azure*` | status/diff/commit facts, provider reads and existing rendering |
| `settings`, `env`, `notes`, `wizardDraft`, `migrate` | workspace/credential separation, secret masking, unknown-field preservation, document/draft data |
| `terminal`, `events`, `origin`, `clean`, `node-runtime`, `serve`, `pages` | session survival, attachment cleanup, origin protection, owned processes, browser/native behavior |

`extensions`, `extension`, `extensionParity`, `outOfTreeExtensions` mostly test loader mechanics
that go away with the platform; the behavior they incidentally cover (included integrations,
per-workspace enablement, notes, Pi reporting) moves to the owning package tests before deletion.

## New acceptance cases

- Starting is legal only from `Ideation`; a second start is `InvalidTransition`; a concurrent
  writer surfaces as `ChangeConflict`.
- A scripted failure in the middle of provisioning leaves the change `Implementation`, returns
  `PartiallyStarted` with the other repositories provisioned, and writes a failed journal entry.
- `inspectChangeRepositories` returns `Missing` for a concept link without running a mutating Git
  command; an unreadable Git call is an error, not `Missing`.
- The checkout-method mapping is exact: `UseOriginalLocationNewBranch` calls `switchBranch`,
  `UseNewLocationNewBranch` calls `addWorktree`, and `UseOriginalLocationOriginalBranch` calls
  neither.
- Two workspace layers with different roots do not share links or checkout paths.
- The transport test encodes a `RepositoryView` and both route and client decode it; every error
  tag maps to exactly one status.
- Real Git: linked worktrees share `commonDirectory`; `removeRepository` cannot reach Git, and the
  adapter's own removal refuses a dirty worktree unless forced.

Tests keep the wrapper rules from the [testing guide](../guides/testing.md): isolated
change/config/cache paths, a private tmux socket per run, and cleanup owned by the run token.
