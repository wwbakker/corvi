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
  readonly hasRemote?: Git.Interface["repo"]["hasRemote"]
  readonly remoteUrl?: Git.Interface["repo"]["remoteUrl"]
  readonly branch?: Git.Interface["history"]["branch"]
  readonly head?: Git.Interface["history"]["head"]
  readonly branchExists?: Git.Interface["history"]["branchExists"]
  readonly refExists?: Git.Interface["history"]["refExists"]
  readonly resolveExistingBranch?: Git.Interface["history"]["resolveExistingBranch"]
  readonly isAncestor?: Git.Interface["history"]["isAncestor"]
  readonly upstream?: Git.Interface["history"]["upstream"]
  readonly defaultRemoteBranch?: Git.Interface["history"]["defaultRemoteBranch"]
  readonly defaultBranch?: Git.Interface["history"]["defaultBranch"]
  readonly upstreamTip?: Git.Interface["history"]["upstreamTip"]
  readonly upstreamCommits?: Git.Interface["history"]["upstreamCommits"]
  readonly status?: Git.Interface["status"]["dirty"]
  readonly integration?: Git.Interface["integration"]["proven"]
  readonly deleteBranch?: Git.Interface["sync"]["deleteBranch"]
  readonly fetchRemote?: Git.Interface["sync"]["fetchRemote"]
  readonly pullFastForward?: Git.Interface["sync"]["pullFastForward"]
  readonly mergeFastForwardOnly?: Git.Interface["sync"]["mergeFastForwardOnly"]
  readonly switchToBranch?: Git.Interface["sync"]["switchToBranch"]
  readonly addWorktree?: Git.Interface["worktree"]["add"]
  readonly remove?: Git.Interface["worktree"]["remove"]
}

const layerFor = (script: GitScript): Layer.Layer<Repositories> =>
  repositoriesLayer.pipe(
    Layer.provide(
      Layer.succeed(Git.Service, {
        repo: {
          discover: script.discover ?? (() => Effect.succeed(undefined)),
          hasRemote: script.hasRemote ?? (() => Effect.succeed(false)),
          remoteUrl: script.remoteUrl ?? (() => Effect.succeed(undefined)),
        },
        history: {
          branch: script.branch ?? (() => Effect.succeed(undefined)),
          head: script.head ?? (() => Effect.succeed(undefined)),
          branchExists: script.branchExists ?? (() => Effect.succeed(false)),
          refExists: script.refExists ?? (() => Effect.succeed(false)),
          resolveExistingBranch: script.resolveExistingBranch ?? (() => Effect.dieMessage("resolveExistingBranch is not scripted")),
          isAncestor: script.isAncestor ?? (() => Effect.succeed(false)),
          upstream: script.upstream ?? (() => Effect.succeed({ _tag: "NoUpstream" } as const)),
          defaultRemoteBranch: script.defaultRemoteBranch ?? (() => Effect.succeed(undefined)),
          defaultBranch: script.defaultBranch ?? (() => Effect.succeed(undefined)),
          upstreamTip: script.upstreamTip ?? (() => Effect.succeed(undefined)),
          upstreamCommits: script.upstreamCommits ?? (() => Effect.succeed([])),
        },
        status: { dirty: script.status ?? (() => Effect.succeed(false)) },
        integration: { proven: script.integration ?? (() => Effect.succeed(false)) },
        sync: {
          deleteBranch: script.deleteBranch ?? (() => Effect.void),
          fetchRemote: script.fetchRemote ?? (() => Effect.void),
          pullFastForward: script.pullFastForward ?? (() => Effect.void),
          mergeFastForwardOnly: script.mergeFastForwardOnly ?? (() => Effect.void),
          switchToBranch: script.switchToBranch ?? (() => Effect.void),
        },
        worktree: {
          add: script.addWorktree ?? (() => Effect.succeed(repository)),
          remove: script.remove ?? (() => Effect.void),
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

test("fastForwardBranch advances exactly when git can, and never rewrites", async () => {
  const forwarded: string[] = []
  const advanced = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.fastForwardBranch({ directory: AbsolutePath.make("/repo"), to: "origin/main" })
    }),
    {
      discover: () => Effect.succeed(repository),
      head: (() => {
        let reads = 0
        return () => Effect.succeed(reads++ === 0 ? "before" : "after")
      })(),
      mergeFastForwardOnly: (_repository, input) => {
        forwarded.push(input.to)
        return Effect.void
      },
    },
  )
  expect(Either.isRight(advanced)).toBe(true)
  if (Either.isRight(advanced)) expect(advanced.right).toEqual({ _tag: "Advanced", to: "origin/main" })
  expect(forwarded).toEqual(["origin/main"])

  const current = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.fastForwardBranch({ directory: AbsolutePath.make("/repo"), to: "origin/main" })
    }),
    { discover: () => Effect.succeed(repository), head: () => Effect.succeed("same") },
  )
  expect(Either.isRight(current)).toBe(true)
  if (Either.isRight(current)) expect(current.right).toEqual({ _tag: "Current" })
})

test("fastForwardBranch leaves a checkout alone with git's own reason", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.fastForwardBranch({ directory: AbsolutePath.make("/repo"), to: "origin/main" })
    }),
    {
      discover: () => Effect.succeed(repository),
      head: () => Effect.succeed("own"),
      mergeFastForwardOnly: () =>
        Effect.fail(new Git.OperationError({ operation: "merge", message: "fatal: Not possible to fast-forward" })),
    },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result))
    expect(result.right).toEqual({ _tag: "LeftAlone", reason: "fatal: Not possible to fast-forward" })
})

test("a dirty tree git refuses to clobber is left alone, not an error", async () => {
  // The middle case the promise names: a fast-forward is possible, but git declines to
  // overwrite uncommitted work. That is a decision, not broken infrastructure.
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.fastForwardBranch({ directory: AbsolutePath.make("/repo"), to: "origin/main" })
    }),
    {
      discover: () => Effect.succeed(repository),
      head: () => Effect.succeed("mine"),
      status: () => Effect.succeed(true),
      mergeFastForwardOnly: () =>
        Effect.fail(
          new Git.OperationError({
            operation: "merge",
            message: "error: Your local changes to 'f.txt' would be overwritten by merge",
          }),
        ),
      isAncestor: () => Effect.succeed(true),
    },
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result))
    expect(result.right).toEqual({
      _tag: "LeftAlone",
      reason: "error: Your local changes to 'f.txt' would be overwritten by merge",
    })
})

test("a fast-forward that was possible and still failed is an error, not a refusal", async () => {
  // An index lock, an I/O problem: ancestry says HEAD could have moved and did not. Reporting
  // that as "left alone" would dress a failure up as a decision.
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.fastForwardBranch({ directory: AbsolutePath.make("/repo"), to: "origin/main" })
    }),
    {
      discover: () => Effect.succeed(repository),
      head: () => Effect.succeed("own"),
      mergeFastForwardOnly: () =>
        Effect.fail(new Git.OperationError({ operation: "merge", message: "Unable to create index.lock" })),
      isAncestor: () => Effect.succeed(true),
    },
  )
  expect(result._tag).toBe("Left")
  if (result._tag === "Left") {
    expect(result.left._tag).toBe("CheckoutError")
    if (result.left._tag === "CheckoutError") expect(result.left.message).toContain("index.lock")
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

test("provisionLinkedWorktree attaches an existing branch", async () => {
  const added: Array<{ branch: string; create: boolean; base?: string }> = []
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionLinkedWorktree({
        source: AbsolutePath.make("/source/repo"),
        directory: AbsolutePath.make("/change/repo"),
        branch: "feature",
        createMissing: true,
      })
    }),
    {
      discover: (dir) => Effect.succeed(String(dir) === "/source/repo" ? repository : undefined),
      branchExists: () => Effect.succeed(true),
      addWorktree: (input) => {
        added.push({ branch: input.branch, create: input.create })
        return Effect.succeed(repository)
      },
    },
  )
  expect(Either.isRight(result)).toBe(true)
  expect(added).toEqual([{ branch: "feature", create: false }])
})

test("attach-only refuses a missing selection before any mutation", async () => {
  const added: Array<{ branch: string; create: boolean }> = []
  let asked = 0
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionLinkedWorktree({
        source: AbsolutePath.make("/source/repo"),
        directory: AbsolutePath.make("/change/repo"),
        branch: "nowhere",
        createMissing: false,
      })
    }),
    {
      discover: (dir) => Effect.succeed(String(dir) === "/source/repo" ? repository : undefined),
      resolveExistingBranch: () => Effect.fail(new Git.OperationError({ operation: "checkout", message: "branch not found: nowhere" })),
      branchExists: () => {
        asked += 1
        return Effect.succeed(false)
      },
      addWorktree: (input) => {
        added.push({ branch: input.branch, create: input.create })
        return Effect.fail(
          new Git.OperationError({ operation: "create", message: "invalid reference: nowhere" }),
        )
      },
    },
  )
  expect(Either.isLeft(result)).toBe(true)
  expect(added).toEqual([])
  expect(asked).toBe(0)
})

test("provisionLinkedWorktree creates the branch from the base the caller made current", async () => {
  // Fetching is the provisioning policy's job (pinned in `@corvi/workflows`' tests); the
  // capability works from the refs it is given.
  const added: Array<{ branch: string; create: boolean; base?: string }> = []
  let fetched = 0
  await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionLinkedWorktree({
        source: AbsolutePath.make("/source/repo"),
        directory: AbsolutePath.make("/change/repo"),
        branch: "feature",
        createMissing: true,
      })
    }),
    {
      discover: (dir) => Effect.succeed(String(dir) === "/source/repo" ? repository : undefined),
      branchExists: () => Effect.succeed(false),
      hasRemote: () => Effect.succeed(true),
      defaultBranch: () => Effect.succeed("origin/main"),
      fetchRemote: () => {
        fetched += 1
        return Effect.void
      },
      addWorktree: (input) => {
        added.push({ branch: input.branch, create: input.create, ...(input.base ? { base: input.base } : {}) })
        return Effect.succeed(repository)
      },
    },
  )
  expect(fetched).toBe(0)
  expect(added).toEqual([{ branch: "feature", create: true, base: "origin/main" }])
})

test("provisionLinkedWorktree leaves an existing checkout alone", async () => {
  let added = 0
  const result = await runEither(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionLinkedWorktree({
        source: AbsolutePath.make("/source/repo"),
        directory: AbsolutePath.make("/change/repo"),
        branch: "feature",
        createMissing: true,
      })
    }),
    {
      discover: () => Effect.succeed(repository),
      branchExists: () => Effect.succeed(false),
      addWorktree: () => {
        added += 1
        return Effect.succeed(repository)
      },
    },
  )
  expect(Either.isRight(result)).toBe(true)
  expect(added).toBe(0)
})

test("provisionInPlace reports already, dirty, switched and created", async () => {
  const run = (script: GitScript): Promise<Either.Either<import("../src/repositories.ts").InPlaceOutcome, unknown>> =>
    runEither(
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return yield* repositories.provisionInPlace({
          source: AbsolutePath.make("/source/repo"),
          branch: "feature",
          createMissing: true,
        })
      }),
      script,
    )

  const already = await run({ discover: () => Effect.succeed(repository), branch: () => Effect.succeed("feature") })
  if (Either.isRight(already)) expect(already.right).toBe("already")
  else expect(true).toBe(false)

  const dirty = await run({
    discover: () => Effect.succeed(repository),
    branch: () => Effect.succeed("main"),
    status: () => Effect.succeed(true),
  })
  if (Either.isRight(dirty)) expect(dirty.right).toBe("skipped-dirty")
  else expect(true).toBe(false)

  const switched = await run({
    discover: () => Effect.succeed(repository),
    branch: () => Effect.succeed("main"),
    branchExists: () => Effect.succeed(true),
  })
  if (Either.isRight(switched)) expect(switched.right).toBe("switched")
  else expect(true).toBe(false)

  const switchedTo: string[] = []
  const created = await run({
    discover: () => Effect.succeed(repository),
    branch: () => Effect.succeed("main"),
    branchExists: () => Effect.succeed(false),
    hasRemote: () => Effect.succeed(true),
    defaultBranch: () => Effect.succeed("origin/main"),
    switchToBranch: (_repository, input) => {
      switchedTo.push(`${input.create ? "create" : "attach"}:${input.base ?? ""}`)
      return Effect.void
    },
  })
  if (Either.isRight(created)) expect(created.right).toBe("created")
  else expect(true).toBe(false)
  expect(switchedTo).toEqual(["create:origin/main"])
})
