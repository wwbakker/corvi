import { afterAll, beforeAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "../src/git.ts"
import { Repositories, layer as repositoriesLayer } from "../src/repositories.ts"
import { layer as commandLayer } from "../src/node/command.ts"
import { layer as gitLayer } from "../src/node/git.ts"

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test",
    },
  }).trim()

const gitLayerForTests: Layer.Layer<Git.Service> = gitLayer.pipe(Layer.provide(commandLayer))
const nodeLayer: Layer.Layer<Repositories> = repositoriesLayer.pipe(Layer.provide(gitLayerForTests))

const withGit = <A, E>(program: Effect.Effect<A, E, Git.Service>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(gitLayerForTests)))

const withRepositories = <A, E>(program: Effect.Effect<A, E, Repositories>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(nodeLayer)))

let tmp: string
let repo: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-git-`))
  repo = join(tmp, "repo")
  execFileSync("git", ["init", "-b", "main", repo])
  await writeFile(join(repo, "README.md"), "hi\n")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "init")
  // A local stand-in for a fetched remote branch, so checkoutRemoteBranch has a target.
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
  git(repo, "update-ref", "refs/remotes/origin/feature", "HEAD")
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

test("discover reports the worktree and the canonical common directory", async () => {
  const found = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      return yield* service.repo.discover(AbsolutePath.make(repo))
    }),
  )
  expect(found?.worktree).toBe(AbsolutePath.make(repo))
  expect(found?.commonDirectory).toBe(AbsolutePath.make(join(repo, ".git")))
})

test("discover answers undefined for a non-repository and for a missing directory", async () => {
  const notARepository = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      return yield* service.repo.discover(AbsolutePath.make(tmp))
    }),
  )
  const missing = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      return yield* service.repo.discover(AbsolutePath.make(join(tmp, "absent")))
    }),
  )
  expect(notARepository).toBeUndefined()
  expect(missing).toBeUndefined()
})

test("a linked worktree shares the repository identity", async () => {
  const worktreeDir = join(tmp, "linked")
  const created = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      return yield* service.worktree.create({ repository, directory: AbsolutePath.make(worktreeDir) })
    }),
  )
  expect(created.commonDirectory).toBe(AbsolutePath.make(join(repo, ".git")))

  const listed = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      return yield* service.worktree.list(repository)
    }),
  )
  expect(listed[0]?.kind).toBe("main")
  expect(listed.map((worktree) => String(worktree.directory))).toContain(worktreeDir)
})

test("a detached linked worktree has a head and no branch", async () => {
  const observed = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const main = yield* service.repo.discover(AbsolutePath.make(repo))
      const linked = yield* service.repo.discover(AbsolutePath.make(join(tmp, "linked")))
      if (!main || !linked) throw new Error("repository not found")
      return {
        mainBranch: yield* service.history.branch(main),
        linkedBranch: yield* service.history.branch(linked),
        linkedHead: yield* service.history.head(linked),
      }
    }),
  )
  expect(observed.mainBranch).toBe("main")
  expect(observed.linkedBranch).toBeUndefined()
  expect(observed.linkedHead).toBeDefined()
})

test("checkoutRemoteBranch creates the branch in the linked worktree", async () => {
  const branch = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const linked = yield* service.repo.discover(AbsolutePath.make(join(tmp, "linked")))
      if (!linked) throw new Error("linked worktree not found")
      yield* service.sync.checkoutRemoteBranch(linked, { branch: "feature" })
      return yield* service.history.branch(linked)
    }),
  )
  expect(branch).toBe("feature")
})

test("worktree removal refuses a dirty worktree unless forced", async () => {
  const dirtyDir = join(tmp, "dirty")
  await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      yield* service.worktree.create({ repository, directory: AbsolutePath.make(dirtyDir) })
    }),
  )
  await writeFile(join(dirtyDir, "note.txt"), "x\n")

  const refused = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      return yield* service.worktree.remove({ repository, directory: AbsolutePath.make(dirtyDir), force: false })
    }).pipe(Effect.either),
  )
  expect(refused._tag).toBe("Left")
  if (refused._tag === "Left") expect(refused.left._tag).toBe("Git.OperationError")

  await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      yield* service.worktree.remove({ repository, directory: AbsolutePath.make(dirtyDir), force: true })
    }),
  )
  const gone = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      return yield* service.repo.discover(AbsolutePath.make(dirtyDir))
    }),
  )
  expect(gone).toBeUndefined()
})

test("the composed node layer inspects a present checkout and an absent one", async () => {
  const present = await withRepositories(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.inspectCheckout(AbsolutePath.make(repo))
    }),
  )
  expect(present._tag).toBe("Present")
  if (present._tag === "Present") {
    expect(present.branch).toBe("main")
    expect(present.head).toBeDefined()
  }

  const missing = await withRepositories(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.inspectCheckout(AbsolutePath.make(join(tmp, "absent")))
    }),
  )
  expect(missing).toEqual({ _tag: "Missing" })
})
