import { expect, test } from "bun:test"
import { Deferred, Effect, Either, Fiber, Layer } from "effect"

import { ChangeService } from "@corvi/changes/changes"
import { ChangeRepositories } from "@corvi/changes/repositories"
import { OperationProgress, type OperationStep } from "@corvi/changes/progress"
import {
  Change,
  ChangeId,
  DirectoryName,
  Repository,
  RepositoryId,
  type CheckoutMethod,
  type RepositoryRef,
} from "@corvi/contracts/changes"
import { Repositories, type RemovalAssessment } from "@corvi/repositories"
import {
  ChangeLifecycle,
  Issues,
  ProviderError,
  PullRequests,
  TerminalSessions,
  layer as lifecycleLayer,
  type Acknowledgement,
  type PullRequestState,
  type Readiness,
} from "../src/lifecycle.ts"

interface Script {
  change: Change
  links: Repository[]
  calls: string[]
  steps: OperationStep[]
  readiness: PullRequestState[]
  removal: RemovalAssessment | (() => RemovalAssessment)
  branchCleanup?: "deleted" | "kept" | "absent"
  loose: readonly { readonly repository: RepositoryRef; readonly number: number }[]
  issue: readonly string[]
  looseFailure: boolean
  /** Signalled by the merge port when the operation is provably in flight. */
  started?: Deferred.Deferred<void>
  hold?: Deferred.Deferred<void>
}

const change = (phase: Change["phase"]): Change =>
  new Change({
    changeId: ChangeId.make("demo"),
    title: "Demo",
    workspaceLocation: "/workspace/demo",
    branch: "demo",
    phase,
    createdAt: "2026-01-01T00:00:00.000Z",
  })

const link = (directoryName: string, checkoutMethod: CheckoutMethod): Repository =>
  new Repository({
    changeId: ChangeId.make("demo"),
    repositoryId: RepositoryId.make(directoryName),
    directoryName: DirectoryName.make(directoryName),
    originalLocation: `/sources/${directoryName}`,
    checkoutMethod,
  })

const ref = (repositoryId: string): RepositoryRef => ({
  changeId: ChangeId.make("demo"),
  repositoryId: RepositoryId.make(repositoryId),
})

const script = (overrides: Partial<Script> = {}): Script => ({
  change: change("Implementation"),
  links: [link("created", "UseNewLocationNewBranch"), link("borrowed", "UseOriginalLocationNewBranch")],
  calls: [],
  steps: [],
  readiness: [
    { repository: ref("created"), number: 7, ready: true, merged: false },
    { repository: ref("borrowed"), number: 8, ready: true, merged: true },
  ],
  removal: { _tag: "Safe" },
  loose: [],
  issue: [],
  looseFailure: false,
  ...overrides,
})

const layerFor = (state: Script): Layer.Layer<ChangeLifecycle> =>
  lifecycleLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChangeService, {
          getChange: () => Effect.succeed(state.change),
          listChanges: () => Effect.succeed([]),
          createChange: () => Effect.succeed(state.change),
          transitionTo: (_changeId, phase) => {
            state.calls.push(`transition ${phase}`)
            state.change = new Change({
              ...state.change,
              phase,
              ...(phase === "Completed" || phase === "Cancelled" ? { completedAt: "then" } : {}),
            })
            return Effect.succeed(state.change)
          },
        }),
        Layer.succeed(ChangeRepositories, {
          listRepositories: () => Effect.succeed(state.links),
          addRepository: (input) =>
            Effect.succeed(new Repository({ ...input, repositoryId: RepositoryId.make("link") })),
          removeRepository: () => Effect.void,
        }),
        Layer.succeed(Repositories, {
          inspectCheckout: () => Effect.succeed({ _tag: "Missing" as const }),
          assessRemoval: () =>
            Effect.succeed(typeof state.removal === "function" ? state.removal() : state.removal),
          removeBranchIfIntegrated: () => Effect.succeed(state.branchCleanup ?? "deleted"),
          switchBranch: () => Effect.void,
          addWorktree: () => Effect.void,
          removeWorktree: (input) => {
            state.calls.push(`remove ${input.worktree}`)
            return Effect.void
          },
        }),
        Layer.succeed(OperationProgress, {
          record: ({ step }) => {
            state.steps.push(step)
            return Effect.void
          },
        }),
        Layer.succeed(PullRequests, {
          readiness: ({ repository }) =>
            Effect.succeed(
              state.readiness.find(
                (entry) => entry.repository.repositoryId === repository.repositoryId,
              ) ?? {
                repository,
                number: 0,
                ready: false,
                merged: false,
                reason: "no pull request",
              },
            ),
          merge: ({ number }) =>
            Effect.gen(function* () {
              state.calls.push(`merge #${number}`)
              if (state.started) yield* Deferred.succeed(state.started, undefined)
              if (state.hold) yield* Deferred.await(state.hold)
              return `merged #${number}`
            }),
          outstanding: () =>
            state.looseFailure
              ? Effect.fail(
                  new ProviderError({ provider: "github", operation: "outstanding", message: "boom" }),
                )
              : Effect.succeed(state.loose),
        }),
        Layer.succeed(Issues, {
          transition: () => {
            state.calls.push("issue transition")
            return Effect.succeed(state.issue.length > 0 ? state.issue.join("; ") : undefined)
          },
          current: () => Effect.succeed(state.issue),
        }),
        Layer.succeed(TerminalSessions, {
          stop: () => {
            state.calls.push("stop terminal")
            return Effect.void
          },
        }),
      ),
    ),
  )

const run = <A, E>(
  state: Script,
  program: Effect.Effect<A, E, ChangeLifecycle>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(program.pipe(Effect.either, Effect.provide(layerFor(state))))

const lifecycle = Effect.gen(function* () {
  return yield* ChangeLifecycle
})

const assessment = (
  state: Script,
  operation: "completion" | "cancellation",
): Promise<Either.Either<Readiness, unknown>> =>
  run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return operation === "completion"
        ? yield* service.assessCompletion(ChangeId.make("demo"))
        : yield* service.assessCancellation(ChangeId.make("demo"))
    }),
  )

test("an idea cannot be completed", async () => {
  const result = await assessment(script({ change: change("Ideation") }), "completion")
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("Blocked")
    if (result.right._tag === "Blocked") expect(result.right.reasons[0]?.code).toBe("idea")
  }
})

test("an unready pull request needs an acknowledgement", async () => {
  const result = await assessment(
    script({
      readiness: [
        { repository: ref("created"), number: 7, ready: false, merged: false, reason: "waiting for review" },
      ],
    }),
    "completion",
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("AcknowledgementRequired")
    if (result.right._tag === "AcknowledgementRequired")
      expect(result.right.reasons[0]?.code).toBe("review-pending")
  }
})

test("a dirty checkout blocks completion", async () => {
  const result = await assessment(
    script({
      removal: {
        _tag: "Unsafe",
        reasons: [{ code: "dirty-worktree", kind: "hard", text: "uncommitted changes", facts: "dirty:abc" }],
      },
    }),
    "completion",
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Blocked")
})

test("unpushed commits need an acknowledgement", async () => {
  const result = await assessment(
    script({
      removal: {
        _tag: "NeedsAcknowledgement",
        reasons: [{ code: "unpushed", kind: "forceable", text: "2 unpushed commit(s)", facts: "unpushed:abc:2" }],
      },
    }),
    "completion",
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("AcknowledgementRequired")
})

test("completion is ready when the pull request is merged and the checkout is safe", async () => {
  const result = await assessment(
    script({
      readiness: [
        { repository: ref("created"), number: 7, ready: true, merged: true },
        { repository: ref("borrowed"), number: 8, ready: true, merged: true },
      ],
    }),
    "completion",
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Ready")
})

test("completion refuses before any step runs when nothing is acknowledged", async () => {
  const state = script({
    removal: {
      _tag: "NeedsAcknowledgement",
      reasons: [{ code: "unpushed", kind: "forceable", text: "2 unpushed commit(s)", facts: "unpushed:abc:2" }],
    },
  })
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.completeChange({ changeId: ChangeId.make("demo") })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("NeedsAcknowledgement")
  expect(state.calls).toEqual([])
  expect(state.steps).toEqual([])
})

test("completion merges, removes only the created checkout, stops the terminal and completes", async () => {
  const state = script()
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.completeChange({ changeId: ChangeId.make("demo") })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("Done")
    if (result.right._tag === "Done") expect(result.right.change.phase).toBe("Completed")
  }
  expect(state.calls).toEqual([
    "merge #7",
    "issue transition",
    "remove /workspace/demo/created",
    "stop terminal",
    "transition Completed",
  ])
  expect(state.steps.map((step) => `${step.id}:${step.state}`)).toContain("archive:done")
  expect(state.steps.filter((step) => step.state === "waiting").map((step) => step.id)).toEqual([
    "merge:/sources/created",
    "issues",
    "worktrees",
    "terminal",
    "archive",
  ])
})

test("a refusal carries what completion would merge", async () => {
  const state = script({
    readiness: [
      { repository: ref("created"), number: 7, ready: true, merged: false },
      { repository: ref("borrowed"), number: 8, ready: false, merged: false, reason: "waiting for review" },
    ],
  })
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.completeChange({ changeId: ChangeId.make("demo") })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("NeedsAcknowledgement")
    if (result.right._tag === "NeedsAcknowledgement")
      expect(result.right.toMerge).toEqual([{ repository: ref("created"), number: 7 }])
  }
})

test("a stale acknowledgement does not authorize the removal", async () => {
  const state = script({
    removal: {
      _tag: "NeedsAcknowledgement",
      reasons: [{ code: "unpushed", kind: "forceable", text: "2 unpushed commit(s)", facts: "unpushed:abc:2" }],
    },
  })
  const stale: readonly Acknowledgement[] = [
    { code: "unpushed", subject: ref("created"), facts: "unpushed:def:2" },
  ]
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.completeChange({ changeId: ChangeId.make("demo"), acknowledgements: stale })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("NeedsAcknowledgement")
  expect(state.calls).toEqual([])
})

test("a matching acknowledgement lets completion proceed", async () => {
  const state = script({
    removal: {
      _tag: "NeedsAcknowledgement",
      reasons: [{ code: "unpushed", kind: "forceable", text: "2 unpushed commit(s)", facts: "unpushed:abc:2" }],
    },
  })
  const acknowledged: readonly Acknowledgement[] = [
    { code: "unpushed", subject: ref("created"), facts: "unpushed:abc:2" },
  ]
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.completeChange({ changeId: ChangeId.make("demo"), acknowledgements: acknowledged })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Done")
})

test("the checkout is rechecked before removal and a changed fact blocks", async () => {
  let calls = 0
  const state = script({
    removal: () => {
      calls += 1
      return calls === 1
        ? { _tag: "Safe" }
        : {
            _tag: "NeedsAcknowledgement",
            reasons: [{ code: "unpushed", kind: "forceable", text: "1 unpushed commit(s)", facts: "unpushed:new:1" }],
          }
    },
  })
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.completeChange({ changeId: ChangeId.make("demo") })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("NeedsAcknowledgement")
  expect(state.calls).not.toContain("remove /workspace/demo/created")
})

test("cancelling a dirty checkout is refused", async () => {
  const result = await assessment(
    script({
      removal: {
        _tag: "Unsafe",
        reasons: [{ code: "dirty-worktree", kind: "hard", text: "uncommitted changes", facts: "dirty:abc" }],
      },
    }),
    "cancellation",
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Blocked")
})

test("cancelling with an acknowledgement removes the checkout and lists the loose ends", async () => {
  const state = script({
    removal: {
      _tag: "NeedsAcknowledgement",
      reasons: [{ code: "unpushed", kind: "forceable", text: "2 unpushed commit(s)", facts: "unpushed:abc:2" }],
    },
    branchCleanup: "kept",
    loose: [{ repository: ref("created"), number: 3 }],
    issue: ["PROJ-1 is still open"],
  })
  const acknowledged: readonly Acknowledgement[] = [
    { code: "unpushed", subject: ref("created"), facts: "unpushed:abc:2" },
  ]
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.cancelChange({ changeId: ChangeId.make("demo"), acknowledgements: acknowledged })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("Done")
    if (result.right._tag === "Done") {
      expect(result.right.change.phase).toBe("Cancelled")
      expect(result.right.loose).toEqual([
        "pull request #3 is still open in created",
        "PROJ-1 is still open",
        "the branch demo is kept in created",
      ])
    }
  }
  expect(state.calls).toEqual(["remove /workspace/demo/created", "stop terminal", "transition Cancelled"])
})

test("a failed loose-end lookup is a note, not a failure", async () => {
  const state = script({ looseFailure: true })
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.cancelChange({ changeId: ChangeId.make("demo") })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result) && result.right._tag === "Done")
    expect(result.right.loose).toContain("could not read the open pull requests")
})

test("an idea can be cancelled", async () => {
  const state = script({ change: change("Ideation"), links: [] })
  const result = await run(
    state,
    Effect.gen(function* () {
      const service = yield* lifecycle
      return yield* service.cancelChange({ changeId: ChangeId.make("demo") })
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Done")
  expect(state.calls).toEqual(["stop terminal", "transition Cancelled"])
})

test("one lifecycle operation per change at a time", async () => {
  const started = await Effect.runPromise(Deferred.make<void>())
  const gate = await Effect.runPromise(Deferred.make<void>())
  const state = script({ started, hold: gate })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* lifecycle
      const first = yield* Effect.fork(service.completeChange({ changeId: ChangeId.make("demo") }))
      yield* Deferred.await(started)
      const second = yield* service.completeChange({ changeId: ChangeId.make("demo") }).pipe(Effect.either)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      return second
    }).pipe(Effect.provide(layerFor(state))),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) {
    const failure = result.left
    expect((failure as { _tag?: string })._tag).toBe("ChangeOperationInProgress")
  }
})
