import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "../src/git.ts"
import { Repositories, layer as repositoriesLayer } from "../src/repositories.ts"
import { layer as commandLayer } from "../src/node/command.ts"
import { layer as gitLayer } from "../src/node/git.ts"

/** git in a fixture's directory. The directory can only vanish while a test runs when something
 * outside this file takes it — which a run once saw happen — and git's own "cannot change to"
 * reads like a typo in the test. Name the real event while the answer is still knowable. */
const git = (cwd: string, ...args: string[]): string => {
  if (!existsSync(cwd)) {
    throw new Error(
      `the fixture directory ${cwd} is gone before 'git ${args.join(" ")}': something outside this file deleted it mid-run`,
    )
  }
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test",
    },
  }).trim()
}

const gitLayerForTests: Layer.Layer<Git.Service> = gitLayer.pipe(Layer.provide(commandLayer))
const nodeLayer: Layer.Layer<Repositories> = repositoriesLayer.pipe(Layer.provide(gitLayerForTests))

const withGit = <A, E>(program: Effect.Effect<A, E, Git.Service>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(gitLayerForTests)))

const withRepositories = <A, E>(program: Effect.Effect<A, E, Repositories>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(nodeLayer)))

/** One test's own world: a temp root, a ready `repo` in it, and `makeRepo` for more
 * repositories under the same root. Every test makes its own and the `afterEach` below takes it
 * away — nothing is shared between tests, so the file has no order to it and no test's cleanup
 * can reach another test's directories. The last part is not tidiness: a run once lost a fixture
 * directory mid-test, and everything shared went with it. */
type Fixture = {
  readonly tmp: string
  readonly repo: string
  /** A fresh repository with `origin/main` and `origin/feature` standing in for fetched remote
   * branches — so checkoutRemoteBranch has a target — and `origin/HEAD` read as the remote's
   * default. The remote URL itself points nowhere: nothing here fetches. */
  readonly makeRepo: (name: string) => Promise<string>
}

/** The fixture roots the current test made, for the `afterEach` below to take away. */
const fixtures: string[] = []

const fixture = async (): Promise<Fixture> => {
  // macOS: `$TMPDIR` is a symlink (`/var/...` is `/private/var/...`) and git reports the physical
  // path it resolves to — `git rev-parse --show-toplevel` and `git worktree list` both do. A
  // fixture made under the logical spelling would then be compared against its own shadow, so
  // make the two spellings the same: temp where git reports. The paths under test are git's own.
  const tmp = await mkdtemp(join(await realpath(tmpdir()), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-git-`))
  fixtures.push(tmp)
  const makeRepo = async (name: string): Promise<string> => {
    const dir = join(tmp, name)
    execFileSync("git", ["init", "-b", "main", dir])
    await writeFile(join(dir, "a.txt"), "a\n")
    git(dir, "add", ".")
    git(dir, "commit", "-m", "init")
    git(dir, "remote", "add", "origin", "/nonexistent/repo")
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(dir, "update-ref", "refs/remotes/origin/feature", "HEAD")
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    return dir
  }
  return { tmp, repo: await makeRepo("repo"), makeRepo }
}

afterEach(async () => {
  for (const tmp of fixtures.splice(0)) await rm(tmp, { recursive: true, force: true })
})

test("discover reports the worktree and the canonical common directory", async () => {
  const { repo } = await fixture()
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
  const { tmp } = await fixture()
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
  const { tmp, repo } = await fixture()
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
  const { tmp, repo } = await fixture()
  // The linked worktree to observe, made here rather than borrowed from another test.
  await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      return yield* service.worktree.create({ repository, directory: AbsolutePath.make(join(tmp, "linked")) })
    }),
  )
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
  const { tmp, repo } = await fixture()
  // The linked worktree to check out into, made here rather than borrowed from another test.
  await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(repo))
      if (!repository) throw new Error("main repository not found")
      return yield* service.worktree.create({ repository, directory: AbsolutePath.make(join(tmp, "linked")) })
    }),
  )
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
  const { tmp, repo } = await fixture()
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
  const { tmp, repo } = await fixture()
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

test("status.dirty reports a modified or untracked working tree", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("status-repo")
  const clean = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.status.dirty(repository)
    }),
  )
  expect(clean).toBe(false)

  await writeFile(join(dir, "untracked.txt"), "x\n")
  const dirty = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.status.dirty(repository)
    }),
  )
  expect(dirty).toBe(true)
})

test("history.upstream distinguishes no upstream, counts, and unreadable comparisons", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("upstream-repo")
  const initial = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.history.upstream(repository)
    }),
  )
  expect(initial).toEqual({ _tag: "NoUpstream" })

  git(dir, "branch", "--set-upstream-to=origin/main", "main")
  const counted = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.history.upstream(repository)
    }),
  )
  expect(counted).toEqual({ _tag: "Counted", ahead: 0, behind: 0 })

  await writeFile(join(dir, "b.txt"), "b\n")
  git(dir, "add", ".")
  git(dir, "commit", "-m", "second")
  const ahead = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.history.upstream(repository)
    }),
  )
  expect(ahead).toEqual({ _tag: "Counted", ahead: 1, behind: 0 })

  git(dir, "update-ref", "-d", "refs/remotes/origin/main")
  const unavailable = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.history.upstream(repository)
    }),
  )
  expect(unavailable).toEqual({ _tag: "Unavailable" })
})

test("history.defaultRemoteBranch reads the remote's symbolic HEAD", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("remote-head-repo")
  const found = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.history.defaultRemoteBranch(repository)
    }),
  )
  expect(found).toBe("main")

  const other = await makeRepo("remote-head-repo-2")
  const missing = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(other))
      if (!repository) throw new Error("repository not found")
      return yield* service.history.defaultRemoteBranch(repository)
    }),
  )
  expect(missing).toBe("main")
})

test("integration.proven proves ancestry", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("ancestor-repo")
  git(dir, "checkout", "-b", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  git(dir, "add", ".")
  git(dir, "commit", "-m", "feature work")
  git(dir, "checkout", "main")
  git(dir, "merge", "--ff-only", "feature")

  const proven = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.integration.proven(repository, { branch: "feature", base: "main" })
    }),
  )
  expect(proven).toBe(true)
})

test("integration.proven proves patch equivalence when commits differ", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("cherry-repo")
  git(dir, "checkout", "-b", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  git(dir, "add", ".")
  git(dir, "commit", "-m", "feature work")
  git(dir, "checkout", "main")
  git(dir, "cherry-pick", "feature")

  const proven = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return yield* service.integration.proven(repository, { branch: "feature", base: "main" })
    }),
  )
  expect(proven).toBe(true)
})

test("integration.proven does not prove unmerged work or unknown revisions", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("unmerged-repo")
  git(dir, "checkout", "-b", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  git(dir, "add", ".")
  git(dir, "commit", "-m", "feature work")
  git(dir, "checkout", "main")

  const result = await withGit(
    Effect.gen(function* () {
      const service = yield* Git.Service
      const repository = yield* service.repo.discover(AbsolutePath.make(dir))
      if (!repository) throw new Error("repository not found")
      return {
        unmerged: yield* service.integration.proven(repository, { branch: "feature", base: "main" }),
        unknownBase: yield* service.integration.proven(repository, { branch: "feature", base: "nope" }),
        unknownBranch: yield* service.integration.proven(repository, { branch: "nope", base: "main" }),
      }
    }),
  )
  expect(result).toEqual({ unmerged: false, unknownBase: false, unknownBranch: false })
})

test("removeBranchIfIntegrated deletes integrated branches and keeps the rest", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("branch-cleanup-repo")
  git(dir, "checkout", "-b", "feature")
  await writeFile(join(dir, "b.txt"), "b\n")
  git(dir, "add", ".")
  git(dir, "commit", "-m", "feature work")
  git(dir, "checkout", "main")
  git(dir, "merge", "--ff-only", "feature")

  const cleanup = (branch: string): Promise<string> =>
    withRepositories(
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return yield* repositories.removeBranchIfIntegrated({
          repository: AbsolutePath.make(dir),
          branch,
        })
      }),
    )

  expect(await cleanup("feature")).toBe("deleted")
  expect(git(dir, "branch", "--list", "feature")).toBe("")

  git(dir, "checkout", "-b", "unmerged")
  await writeFile(join(dir, "c.txt"), "c\n")
  git(dir, "add", ".")
  git(dir, "commit", "-m", "unmerged work")
  git(dir, "checkout", "main")
  expect(await cleanup("unmerged")).toBe("kept")
  expect(git(dir, "branch", "--list", "unmerged")).toContain("unmerged")

  expect(await cleanup("never-existed")).toBe("absent")
})

test("provisionLinkedWorktree creates a worktree on a new branch from the remote default", async () => {
  const { tmp, makeRepo } = await fixture()
  const dir = await makeRepo("provision-repo")
  const worktree = join(tmp, "provision-wt")
  await withRepositories(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      yield* repositories.provisionLinkedWorktree({
        source: AbsolutePath.make(dir),
        directory: AbsolutePath.make(worktree),
        branch: "feature",
        createMissing: true,
      })
    }),
  )
  expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe("feature")
})

test("provisionInPlace creates the branch in place and leaves a dirty checkout alone", async () => {
  const { makeRepo } = await fixture()
  const dir = await makeRepo("inplace-repo")
  const created = await withRepositories(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionInPlace({
        source: AbsolutePath.make(dir),
        branch: "feature",
        createMissing: true,
      })
    }),
  )
  expect(created).toBe("created")
  expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("feature")

  const again = await withRepositories(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionInPlace({
        source: AbsolutePath.make(dir),
        branch: "feature",
        createMissing: true,
      })
    }),
  )
  expect(again).toBe("already")

  const dirtyDir = await makeRepo("inplace-dirty-repo")
  await writeFile(join(dirtyDir, "wip.txt"), "x\n")
  const dirty = await withRepositories(
    Effect.gen(function* () {
      const repositories = yield* Repositories
      return yield* repositories.provisionInPlace({
        source: AbsolutePath.make(dirtyDir),
        branch: "feature",
        createMissing: true,
      })
    }),
  )
  expect(dirty).toBe("skipped-dirty")
})
