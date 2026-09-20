import { expect, test } from "bun:test"
import { Effect, Either, Layer } from "effect"

import { ChangeService } from "@corvi/changes/changes"
import { ChangeRepositories } from "@corvi/changes/repositories"
import {
  Change,
  ChangeId,
  DirectoryName,
  Repository,
  RepositoryId,
  type CheckoutMethod,
} from "@corvi/contracts/changes"
import {
  CheckoutError,
  NotARepository,
  Repositories,
  type CheckoutInspection,
} from "@corvi/repositories"
import {
  ChangeWork,
  OperationProgress,
  describeProvisionError,
  layer as changeWorkLayer,
  type OperationStep,
} from "../src/change-work.ts"

interface Script {
  change: Change
  links: Repository[]
  calls: string[]
  steps: OperationStep[]
  inspect: CheckoutInspection
  inspectFailure?: CheckoutError
  failAddFor?: string
}

const change = (phase: Change["phase"]): Change =>
  new Change({
    changeId: ChangeId.make("example"),
    title: "Example",
    workspaceLocation: "/workspace/example",
    branch: "example",
    phase,
    createdAt: "2026-01-01T00:00:00.000Z",
  })

const link = (directoryName: string, checkoutMethod: CheckoutMethod): Repository =>
  new Repository({
    changeId: ChangeId.make("example"),
    repositoryId: RepositoryId.make(directoryName),
    directoryName: DirectoryName.make(directoryName),
    originalLocation: `/sources/${directoryName}`,
    checkoutMethod,
  })

const script = (overrides: Partial<Script> = {}): Script => ({
  change: change("Ideation"),
  links: [],
  calls: [],
  steps: [],
  inspect: { _tag: "Missing" },
  ...overrides,
})

const layerFor = (state: Script): Layer.Layer<ChangeWork> =>
  changeWorkLayer.pipe(
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
          inspectCheckout: () =>
            state.inspectFailure ? Effect.fail(state.inspectFailure) : Effect.succeed(state.inspect),
          switchBranch: (input) => {
            state.calls.push(`switch ${input.branch}`)
            return Effect.void
          },
          addWorktree: (input) => {
            state.calls.push(`add ${input.directory}`)
            return state.failAddFor && String(input.directory).endsWith(`/${state.failAddFor}`)
              ? Effect.fail(
                  new CheckoutError({
                    operation: "add-worktree",
                    directory: String(input.directory),
                    message: "worktree add failed",
                  }),
                )
              : Effect.void
          },
          removeWorktree: () => Effect.void,
        }),
        Layer.succeed(OperationProgress, {
          record: ({ step }) => {
            state.steps.push(step)
            return Effect.void
          },
        }),
      ),
    ),
  )

const run = <A, E>(state: Script, program: Effect.Effect<A, E, ChangeWork>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(program.pipe(Effect.either, Effect.provide(layerFor(state))))

const work = Effect.gen(function* () {
  return yield* ChangeWork
})

test("inspectChangeRepositories joins the change, its links, and the checkout facts", async () => {
  const expected = link("repo", "UseNewLocationNewBranch")
  const state = script({
    change: change("Implementation"),
    links: [expected],
    inspect: { _tag: "Present", branch: "example", head: "abc" },
  })
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.inspectChangeRepositories(ChangeId.make("example"))
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right[0]).toEqual({
      repository: expected,
      state: "Active",
      checkoutLocation: "/workspace/example/repo",
      checkout: { _tag: "Present", branch: "example", head: "abc" },
    })
  }
})

test("inspection failures propagate", async () => {
  const state = script({
    change: change("Implementation"),
    links: [link("repo", "UseNewLocationNewBranch")],
    inspectFailure: new CheckoutError({
      operation: "inspect",
      directory: "/workspace/example/repo",
      message: "unreadable",
    }),
  })
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.inspectChangeRepositories(ChangeId.make("example"))
    }),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("CheckoutError")
})

test("startChange refuses a change that is not an idea", async () => {
  const state = script({ change: change("Implementation") })
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.startChange(ChangeId.make("example"))
    }),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("InvalidTransition")
  expect(state.calls).toEqual([])
})

test("startChange persists the phase before provisioning", async () => {
  const state = script({ links: [link("repo", "UseNewLocationNewBranch")] })
  await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.startChange(ChangeId.make("example"))
    }),
  )
  expect(state.calls[0]).toBe("transition Implementation")
  expect(state.calls[1]).toBe("add /workspace/example/repo")
})

test("each checkout method maps to its operation", async () => {
  const state = script({
    links: [
      link("in-place", "UseOriginalLocationOriginalBranch"),
      link("switched", "UseOriginalLocationNewBranch"),
      link("linked", "UseNewLocationNewBranch"),
    ],
  })
  await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.startChange(ChangeId.make("example"))
    }),
  )
  expect(state.calls).toEqual([
    "transition Implementation",
    "switch example",
    "add /workspace/example/linked",
  ])
})

test("a failed provision is PartiallyStarted with a journal entry per repository", async () => {
  const state = script({
    links: [link("good", "UseNewLocationNewBranch"), link("bad", "UseNewLocationNewBranch")],
    failAddFor: "bad",
  })
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.startChange(ChangeId.make("example"))
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("PartiallyStarted")
    if (result.right._tag === "PartiallyStarted") {
      expect(result.right.repositories.map((repository) => repository.directoryName)).toEqual([
        DirectoryName.make("good"),
      ])
      expect(result.right.failures.map((failure) => failure.repositoryId)).toEqual([RepositoryId.make("bad")])
    }
  }
  expect(state.steps.map((step) => step.state)).toEqual(["running", "done", "running", "failed"])
})

test("a clean start is Started", async () => {
  const state = script({ links: [link("repo", "UseNewLocationNewBranch")] })
  const result = await run(
    state,
    Effect.gen(function* () {
      const changeWork = yield* work
      return yield* changeWork.startChange(ChangeId.make("example"))
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Started")
  expect(state.steps.map((step) => step.state)).toEqual(["running", "done"])
  expect(state.change.phase).toBe("Implementation")
})

test("describeProvisionError names a non-repository", () => {
  expect(describeProvisionError(new NotARepository({ directory: "/sources/repo" }))).toContain("/sources/repo")
})
