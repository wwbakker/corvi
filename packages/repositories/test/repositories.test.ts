import { expect, test } from "bun:test"
import { Effect, Either, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "../src/git.ts"
import { Repositories, layer as repositoriesLayer, type RemovalAssessment } from "../src/repositories.ts"

const repository = new Git.Repository({
  worktree: AbsolutePath.make("/repo"),
  gitDirectory: AbsolutePath.make("/repo/.git"),
  commonDirectory: AbsolutePath.make("/repo/.git"),
})

interface GitScript {
  readonly discover?: Git.Interface["repo"]["discover"]
  readonly branch?: Git.Interface["history"]["branch"]
  readonly head?: Git.Interface["history"]["head"]
  readonly branchExists?: Git.Interface["history"]["branchExists"]
  readonly upstream?: Git.Interface["history"]["upstream"]
  readonly defaultRemoteBranch?: Git.Interface["history"]["defaultRemoteBranch"]
  readonly status?: Git.Interface["status"]["dirty"]
  readonly integration?: Git.Interface["integration"]["proven"]
  readonly checkoutRemoteBranch?: Git.Interface["sync"]["checkoutRemoteBranch"]
  readonly deleteBranch?: Git.Interface["sync"]["deleteBranch"]
  readonly create?: Git.Interface["worktree"]["create"]
  readonly remove?: Git.Interface["worktree"]["remove"]
  readonly list?: Git.Interface["worktree"]["list"]
}

const layerFor = (script: GitScript): Layer.Layer<Repositories> =>
  repositoriesLayer.pipe(
    Layer.provide(
      Layer.succeed(Git.Service, {
        repo: { discover: script.discover ?? (() => Effect.succeed(undefined)) },
        history: {
          branch: script.branch ?? (() => Effect.succeed(undefined)),
          head: script.head ?? (() => Effect.succeed(undefined)),
          branchExists: script.branchExists ?? (() => Effect.succeed(false)),
          upstream: script.upstream ?? (() => Effect.succeed({ _tag: "NoUpstream" } as const)),
          defaultRemoteBranch: script.defaultRemoteBranch ?? (() => Effect.succeed(undefined)),
        },
        status: { dirty: script.status ?? (() => Effect.succeed(false)) },
        integration: { proven: script.integration ?? (() => Effect.succeed(false)) },
        sync: {
          checkoutRemoteBranch: script.checkoutRemoteBranch ?? (() => Effect.void),
          deleteBranch: script.deleteBranch ?? (() => Effect.void),
        },
        worktree: {
          create: script.create ?? (() => Effect.succeed(repository)),
          remove: script.remove ?? (() => Effect.void),
          list: script.list ?? (() => Effect.succeed([])),
        },
      }),
    ),
  )

const runEither = <A, E>(
  program: Effect.Effect<A, E, Repositories>,
  script: GitScript,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(program.pipe(Effect.either, Effect.provide(layerFor(script))))

test("inspectCheckout reports Missing when the location holds no repository", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.inspectCheckout(AbsolutePath.make("/missing"))
    }),
    {},
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right).toEqual({ _tag: "Missing" })
})

test("inspectCheckout reports the observed branch and head", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.inspectCheckout(AbsolutePath.make("/repo"))
    }),
    {
      discover: () => Effect.succeed(repository),
      branch: () => Effect.succeed("main"),
      head: () => Effect.succeed("abc123"),
    },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result))
    expect(result.right).toEqual({ _tag: "Present", branch: "main", head: "abc123" })
})

test("inspectCheckout treats a Git failure as an error, not absence", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.inspectCheckout(AbsolutePath.make("/repo"))
    }),
    {
      discover: () => Effect.fail(new Git.OperationError({ operation: "discover", message: "git is missing" })),
    },
  )
  expect(result._tag).toBe("Left")
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("CheckoutError")
    if (result.left._tag === "CheckoutError") expect(result.left.operation).toBe("inspect")
  }
})

test("switchBranch refuses a location that is not a repository", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.switchBranch({ worktree: AbsolutePath.make("/nope"), branch: "feature" })
    }),
    {},
  )
  expect(result._tag).toBe("Left")
  if (result._tag === "Left") expect(result.left._tag).toBe("NotARepository")
})

test("switchBranch checks out the requested branch", async () => {
  const calls: string[] = []
  await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.switchBranch({ worktree: AbsolutePath.make("/repo"), branch: "feature" })
    }),
    {
      discover: () => Effect.succeed(repository),
      checkoutRemoteBranch: (_repository, input) => {
        calls.push(input.branch)
        return Effect.void
      },
    },
  )
  expect(calls).toEqual(["feature"])
})

test("addWorktree creates the worktree, then checks out the branch", async () => {
  const calls: string[] = []
  await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.addWorktree({
        source: AbsolutePath.make("/repo"),
        directory: AbsolutePath.make("/change/repo"),
        branch: "feature",
      })
    }),
    {
      discover: () => Effect.succeed(repository),
      create: (input) => {
        calls.push(`create ${input.directory}`)
        return Effect.succeed(repository)
      },
      checkoutRemoteBranch: (_repository, input) => {
        calls.push(`checkout ${input.branch}`)
        return Effect.void
      },
    },
  )
  expect(calls).toEqual(["create /change/repo", "checkout feature"])
})

test("addWorktree maps a create failure to CheckoutError", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.addWorktree({
        source: AbsolutePath.make("/repo"),
        directory: AbsolutePath.make("/change/repo"),
        branch: "feature",
      })
    }),
    {
      discover: () => Effect.succeed(repository),
      create: () => Effect.fail(new Git.OperationError({ operation: "create", message: "exists" })),
    },
  )
  expect(result._tag).toBe("Left")
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("CheckoutError")
    if (result.left._tag === "CheckoutError") expect(result.left.operation).toBe("add-worktree")
  }
})

test("removeWorktree passes the force decision through", async () => {
  const forces: boolean[] = []
  await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.removeWorktree({ worktree: AbsolutePath.make("/change/repo"), force: true })
    }),
    {
      discover: () => Effect.succeed(repository),
      remove: (input) => {
        forces.push(input.force)
        return Effect.void
      },
    },
  )
  expect(forces).toEqual([true])
})

const assess = (script: GitScript): Promise<Either.Either<RemovalAssessment, unknown>> =>
  runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.assessRemoval({ worktree: AbsolutePath.make("/change/repo"), branch: "feature" })
    }),
    script,
  )

test("assessRemoval refuses a dirty worktree", async () => {
  const result = await assess({ discover: () => Effect.succeed(repository), status: () => Effect.succeed(true) })
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Unsafe")
})

test("assessRemoval acknowledges unpushed commits when the base cannot prove them", async () => {
  const result = await assess({
    discover: () => Effect.succeed(repository),
    upstream: () => Effect.succeed({ _tag: "Counted", ahead: 2, behind: 0 } as const),
    defaultRemoteBranch: () => Effect.succeed("main"),
    integration: () => Effect.succeed(false),
  })
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("NeedsAcknowledgement")
    if (result.right._tag === "NeedsAcknowledgement")
      expect(result.right.reasons[0]?.text).toBe("2 unpushed commit(s)")
  }
})

test("assessRemoval is safe when the base proves the branch landed", async () => {
  const result = await assess({
    discover: () => Effect.succeed(repository),
    upstream: () => Effect.succeed({ _tag: "Counted", ahead: 2, behind: 0 } as const),
    defaultRemoteBranch: () => Effect.succeed("main"),
    integration: () => Effect.succeed(true),
  })
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Safe")
})

test("assessRemoval acknowledges branches that were never pushed when unproven", async () => {
  const result = await assess({ discover: () => Effect.succeed(repository) })
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("NeedsAcknowledgement")
    if (result.right._tag === "NeedsAcknowledgement")
      expect(result.right.reasons[0]?.text).toBe("commits that were never pushed")
  }
})

test("assessRemoval is safe for an unpushed branch the base proves landed", async () => {
  const result = await assess({
    discover: () => Effect.succeed(repository),
    defaultRemoteBranch: () => Effect.succeed("main"),
    integration: () => Effect.succeed(true),
  })
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right._tag).toBe("Safe")
})

test("assessRemoval treats an unreadable upstream comparison as not proven", async () => {
  const result = await assess({
    discover: () => Effect.succeed(repository),
    upstream: () => Effect.succeed({ _tag: "Unavailable" } as const),
    defaultRemoteBranch: () => Effect.succeed("main"),
  })
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right._tag).toBe("NeedsAcknowledgement")
    if (result.right._tag === "NeedsAcknowledgement")
      expect(result.right.reasons[0]?.text).toBe("the upstream comparison is unavailable")
  }
})

test("assessRemoval refuses a location that is not a repository", async () => {
  const result = await assess({})
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect((result.left as { _tag: string })._tag).toBe("NotARepository")
})

test("removeBranchIfIntegrated deletes a branch the base proves landed", async () => {
  const deleted: string[] = []
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.removeBranchIfIntegrated({
        repository: AbsolutePath.make("/repo"),
        branch: "feature",
      })
    }),
    {
      discover: () => Effect.succeed(repository),
      branchExists: () => Effect.succeed(true),
      defaultRemoteBranch: () => Effect.succeed("main"),
      integration: () => Effect.succeed(true),
      deleteBranch: (_repository, branch) => {
        deleted.push(branch)
        return Effect.void
      },
    },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right).toBe("deleted")
  expect(deleted).toEqual(["feature"])
})

test("removeBranchIfIntegrated keeps a branch the base cannot prove landed", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.removeBranchIfIntegrated({
        repository: AbsolutePath.make("/repo"),
        branch: "feature",
      })
    }),
    {
      discover: () => Effect.succeed(repository),
      branchExists: () => Effect.succeed(true),
      defaultRemoteBranch: () => Effect.succeed("main"),
      integration: () => Effect.succeed(false),
    },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right).toBe("kept")
})

test("removeBranchIfIntegrated reports a branch that never existed as absent", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.removeBranchIfIntegrated({
        repository: AbsolutePath.make("/repo"),
        branch: "feature",
      })
    }),
    { discover: () => Effect.succeed(repository), branchExists: () => Effect.succeed(false) },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right).toBe("absent")
})

test("a branch that refuses deletion is reported kept, not failed", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.removeBranchIfIntegrated({
        repository: AbsolutePath.make("/repo"),
        branch: "feature",
      })
    }),
    {
      discover: () => Effect.succeed(repository),
      branchExists: () => Effect.succeed(true),
      defaultRemoteBranch: () => Effect.succeed("main"),
      integration: () => Effect.succeed(true),
      deleteBranch: () => Effect.fail(new Git.OperationError({ operation: "remove", message: "checked out" })),
    },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) expect(result.right).toBe("kept")
})
