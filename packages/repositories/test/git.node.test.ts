import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import * as Git from "../src/git.ts"
import {
  CheckoutError,
  NotARepository,
  Repositories,
  type BranchCleanup,
  layer as repositoriesLayer,
} from "../src/repositories.ts"
import { layer as commandLayer } from "../src/node/command.ts"
import { layer as gitLayer } from "../src/node/git.ts"
import { Fixture, git, runScoped, sandboxLayer } from "./sandbox.ts"

/** The Effect deadline fires first; Bun's own timeout is the outer, never-reached bound. Bun
 * abandons a body without cancelling it, so only Effect's timeout runs the sandbox release. */
const EFFECT_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 90_000

const gitLayerForTests: Layer.Layer<Git.Service> = gitLayer.pipe(Layer.provide(commandLayer))
const nodeLayer: Layer.Layer<Repositories> = repositoriesLayer.pipe(Layer.provide(gitLayerForTests))

const withGit = <A, E>(program: Effect.Effect<A, E, Fixture | Git.Service>): Promise<A> =>
  runScoped(program, Layer.merge(sandboxLayer, gitLayerForTests), EFFECT_TIMEOUT_MS)

const withRepositories = <A, E>(program: Effect.Effect<A, E, Fixture | Repositories>): Promise<A> =>
  runScoped(program, Layer.merge(sandboxLayer, nodeLayer), EFFECT_TIMEOUT_MS)

test(
  "discover reports the worktree and the canonical common directory",
  () =>
    withGit(
      Effect.gen(function* () {
        const { repo } = yield* Fixture
        const service = yield* Git.Service
        const found = yield* service.repo.discover(AbsolutePath.make(repo))
        expect(found?.worktree).toBe(AbsolutePath.make(repo))
        expect(found?.commonDirectory).toBe(AbsolutePath.make(join(repo, ".git")))
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "discover answers undefined for a non-repository and for a missing directory",
  () =>
    withGit(
      Effect.gen(function* () {
        const { tmp } = yield* Fixture
        const service = yield* Git.Service
        const notARepository = yield* service.repo.discover(AbsolutePath.make(tmp))
        const missing = yield* service.repo.discover(AbsolutePath.make(join(tmp, "absent")))
        expect(notARepository).toBeUndefined()
        expect(missing).toBeUndefined()
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "a linked worktree shares the repository identity",
  () =>
    withGit(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const service = yield* Git.Service
        const worktreeDir = join(tmp, "linked")
        const repository = yield* service.repo.discover(AbsolutePath.make(repo))
        if (!repository) throw new Error("main repository not found")
        const created = yield* service.worktree.add({
          repository,
          directory: AbsolutePath.make(worktreeDir),
          branch: "feature",
          create: true,
        })
        expect(created.commonDirectory).toBe(AbsolutePath.make(join(repo, ".git")))

        const linked = yield* service.repo.discover(AbsolutePath.make(worktreeDir))
        expect(linked?.commonDirectory).toBe(AbsolutePath.make(join(repo, ".git")))
        expect(linked?.worktree).toBe(AbsolutePath.make(worktreeDir))
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "a detached linked worktree has a head and no branch",
  () =>
    withGit(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        // The linked worktree to observe, made with git directly: the port adds worktrees onto
        // named branches, and this observes the detached case's reads.
        git(repo, "worktree", "add", "--detach", join(tmp, "linked"), "HEAD")
        const service = yield* Git.Service
        const main = yield* service.repo.discover(AbsolutePath.make(repo))
        const linked = yield* service.repo.discover(AbsolutePath.make(join(tmp, "linked")))
        if (!main || !linked) throw new Error("repository not found")
        const mainBranch = yield* service.history.branch(main)
        const linkedBranch = yield* service.history.branch(linked)
        const linkedHead = yield* service.history.head(linked)
        expect(mainBranch).toBe("main")
        expect(linkedBranch).toBeUndefined()
        expect(linkedHead).toBeDefined()
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "mergeFastForwardOnly moves HEAD exactly when that is a fast-forward",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("ff-repo"))
        // `old` sits where main is now; main then moves on. Fast-forwarding `old` to `main` is exact.
        git(dir, "branch", "old")
        yield* Effect.promise(() => writeFile(join(dir, "b.txt"), "b\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "main moves")
        git(dir, "checkout", "old")

        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        yield* service.sync.mergeFastForwardOnly(repository, { to: "main" })
        const advanced = yield* service.history.head(repository)
        expect(advanced).toBe(git(dir, "rev-parse", "main"))

        // A branch with its own commits while the target moved on is refused — with git's own
        // words — and left as it was.
        git(dir, "checkout", "main")
        yield* Effect.promise(() => writeFile(join(dir, "d.txt"), "d\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "main moves on")
        git(dir, "checkout", "-b", "own", "old")
        yield* Effect.promise(() => writeFile(join(dir, "c.txt"), "c\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "own work")
        const before = git(dir, "rev-parse", "HEAD")
        const refused = yield* service.sync.mergeFastForwardOnly(repository, { to: "main" }).pipe(Effect.result)
        expect(refused._tag).toBe("Failure")
        if (refused._tag === "Failure")
          // git's verdict, not its advice column: the message is the sentence a report shows.
          expect(refused.failure.message).toContain("Not possible to fast-forward")
        if (refused._tag === "Failure") expect(refused.failure.message).not.toContain("hint:")
        expect(git(dir, "rev-parse", "HEAD")).toBe(before)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "worktree removal refuses a dirty worktree unless forced",
  () =>
    withGit(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const service = yield* Git.Service
        const dirtyDir = join(tmp, "dirty")
        const repository = yield* service.repo.discover(AbsolutePath.make(repo))
        if (!repository) throw new Error("main repository not found")
        yield* service.worktree.add({
          repository,
          directory: AbsolutePath.make(dirtyDir),
          branch: "fixture",
          create: true,
        })
        yield* Effect.promise(() => writeFile(join(dirtyDir, "note.txt"), "x\n"))

        const refused = yield* service.worktree
          .remove({ repository, directory: AbsolutePath.make(dirtyDir), force: false })
          .pipe(Effect.result)
        expect(refused._tag).toBe("Failure")
        if (refused._tag === "Failure") expect(refused.failure._tag).toBe("Git.OperationError")

        yield* service.worktree.remove({ repository, directory: AbsolutePath.make(dirtyDir), force: true })
        const gone = yield* service.repo.discover(AbsolutePath.make(dirtyDir))
        expect(gone).toBeUndefined()
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "the composed node layer inspects a present checkout and an absent one",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const present = yield* repositories.inspectCheckout(AbsolutePath.make(repo))
        expect(present._tag).toBe("Present")
        if (present._tag === "Present") {
          expect(present.branch).toBe("main")
          expect(present.head).toBeDefined()
        }

        const missing = yield* repositories.inspectCheckout(AbsolutePath.make(join(tmp, "absent")))
        expect(missing).toEqual({ _tag: "Missing" })
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "status.dirty reports a modified or untracked working tree",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("status-repo"))
        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        const clean = yield* service.status.dirty(repository)
        expect(clean).toBe(false)

        yield* Effect.promise(() => writeFile(join(dir, "untracked.txt"), "x\n"))
        const dirty = yield* service.status.dirty(repository)
        expect(dirty).toBe(true)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "history.upstream distinguishes no upstream, counts, and unreadable comparisons",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("upstream-repo"))
        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        const initial = yield* service.history.upstream(repository)
        expect(initial).toEqual({ _tag: "NoUpstream" })

        git(dir, "branch", "--set-upstream-to=origin/main", "main")
        const counted = yield* service.history.upstream(repository)
        expect(counted).toEqual({ _tag: "Counted", ahead: 0, behind: 0 })

        yield* Effect.promise(() => writeFile(join(dir, "b.txt"), "b\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "second")
        const ahead = yield* service.history.upstream(repository)
        expect(ahead).toEqual({ _tag: "Counted", ahead: 1, behind: 0 })

        git(dir, "update-ref", "-d", "refs/remotes/origin/main")
        const unavailable = yield* service.history.upstream(repository)
        expect(unavailable).toEqual({ _tag: "Unavailable" })
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "history.defaultRemoteBranch reads the remote's symbolic HEAD",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("remote-head-repo"))
        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        const found = yield* service.history.defaultRemoteBranch(repository)
        expect(found).toBe("main")

        const other = yield* Effect.promise(() => makeRepo("remote-head-repo-2"))
        const otherRepository = yield* service.repo.discover(AbsolutePath.make(other))
        if (!otherRepository) throw new Error("repository not found")
        const missing = yield* service.history.defaultRemoteBranch(otherRepository)
        expect(missing).toBe("main")
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "integration.proven proves ancestry",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("ancestor-repo"))
        git(dir, "checkout", "-b", "feature")
        yield* Effect.promise(() => writeFile(join(dir, "b.txt"), "b\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "feature work")
        git(dir, "checkout", "main")
        git(dir, "merge", "--ff-only", "feature")

        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        const proven = yield* service.integration.proven(repository, { branch: "feature", base: "main" })
        expect(proven).toBe(true)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "integration.proven proves patch equivalence when commits differ",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("cherry-repo"))
        git(dir, "checkout", "-b", "feature")
        yield* Effect.promise(() => writeFile(join(dir, "b.txt"), "b\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "feature work")
        git(dir, "checkout", "main")
        git(dir, "cherry-pick", "feature")

        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        const proven = yield* service.integration.proven(repository, { branch: "feature", base: "main" })
        expect(proven).toBe(true)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "integration.proven does not prove unmerged work or unknown revisions",
  () =>
    withGit(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const service = yield* Git.Service
        const dir = yield* Effect.promise(() => makeRepo("unmerged-repo"))
        git(dir, "checkout", "-b", "feature")
        yield* Effect.promise(() => writeFile(join(dir, "b.txt"), "b\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "feature work")
        git(dir, "checkout", "main")

        const repository = yield* service.repo.discover(AbsolutePath.make(dir))
        if (!repository) throw new Error("repository not found")
        const unmerged = yield* service.integration.proven(repository, { branch: "feature", base: "main" })
        const unknownBase = yield* service.integration.proven(repository, { branch: "feature", base: "nope" })
        const unknownBranch = yield* service.integration.proven(repository, { branch: "nope", base: "main" })
        expect({ unmerged, unknownBase, unknownBranch }).toEqual({ unmerged: false, unknownBase: false, unknownBranch: false })
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "removeBranchIfIntegrated deletes integrated branches and keeps the rest",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const repositories = yield* Repositories
        const dir = yield* Effect.promise(() => makeRepo("branch-cleanup-repo"))
        git(dir, "checkout", "-b", "feature")
        yield* Effect.promise(() => writeFile(join(dir, "b.txt"), "b\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "feature work")
        git(dir, "checkout", "main")
        git(dir, "merge", "--ff-only", "feature")

        const cleanup = (branch: string): Effect.Effect<BranchCleanup, NotARepository | CheckoutError> =>
          repositories.removeBranchIfIntegrated({ repository: AbsolutePath.make(dir), branch })

        const deleted = yield* cleanup("feature")
        expect(deleted).toBe("deleted")
        expect(git(dir, "branch", "--list", "feature")).toBe("")

        git(dir, "checkout", "-b", "unmerged")
        yield* Effect.promise(() => writeFile(join(dir, "c.txt"), "c\n"))
        git(dir, "add", ".")
        git(dir, "commit", "-m", "unmerged work")
        git(dir, "checkout", "main")
        const kept = yield* cleanup("unmerged")
        expect(kept).toBe("kept")
        expect(git(dir, "branch", "--list", "unmerged")).toContain("unmerged")

        const absent = yield* cleanup("never-existed")
        expect(absent).toBe("absent")
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "provisionLinkedWorktree creates a worktree on a new branch from the remote default",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, makeRepo } = yield* Fixture
        const repositories = yield* Repositories
        const dir = yield* Effect.promise(() => makeRepo("provision-repo"))
        const worktree = join(tmp, "provision-wt")
        yield* repositories.provisionLinkedWorktree({
          source: AbsolutePath.make(dir),
          directory: AbsolutePath.make(worktree),
          branch: "feature",
          createMissing: true,
        })
        expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe("feature")
      }),
    ),
  TEST_TIMEOUT_MS,
)

for (const location of ["new", "original"] as const) {
  for (const selection of ["feature", "origin/feature", "origin/team/topic", "upstream/team/topic"]) {
    for (const localExists of [false, true]) {
      test(
        `existing ${selection}, local=${localExists}, ${location}: attached and tracking`,
        () =>
          withRepositories(
            Effect.gen(function* () {
              const { repo, tmp } = yield* Fixture
              const repositories = yield* Repositories
              const remote = selection.startsWith("upstream/") ? "upstream" : "origin"
              const branch = selection === "feature" ? "feature" : selection.slice(remote.length + 1)
              if (remote !== "origin") git(repo, "remote", "add", remote, "/nonexistent/upstream")
              git(repo, "update-ref", `refs/remotes/${remote}/${branch}`, "HEAD")
              if (localExists) git(repo, "branch", "--track", branch, `${remote}/${branch}`)
              const directory = location === "new" ? join(tmp, "attached") : repo
              const selected = yield* repositories.resolveExistingBranch(AbsolutePath.make(repo), selection)
              expect(selected).toEqual({ branch, remote, remoteRef: `${remote}/${branch}` })
              if (location === "new")
                yield* repositories.provisionLinkedWorktree({
                  source: AbsolutePath.make(repo),
                  directory: AbsolutePath.make(directory),
                  branch: selection,
                  createMissing: false,
                })
              else
                yield* repositories.provisionInPlace({
                  source: AbsolutePath.make(repo),
                  branch: selection,
                  createMissing: false,
                })
              expect(git(directory, "symbolic-ref", "--short", "HEAD")).toBe(branch)
              expect(git(directory, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`${remote}/${branch}`)
              expect(git(directory, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", `${remote}/${branch}`))
            }),
          ),
        TEST_TIMEOUT_MS,
      )
    }
  }
}

test(
  "existing branch resolution refuses missing, ambiguous, symbolic, and conflicting selections",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { repo } = yield* Fixture
        const repositories = yield* Repositories
        git(repo, "remote", "add", "upstream", "/nonexistent/upstream")
        git(repo, "update-ref", "refs/remotes/upstream/feature", "HEAD")
        const resolve = (name: string): Effect.Effect<Git.ExistingBranch, NotARepository | CheckoutError> =>
          repositories.resolveExistingBranch(AbsolutePath.make(repo), name)

        const absent = yield* resolve("absent").pipe(Effect.result)
        expect(absent._tag).toBe("Failure")
        if (absent._tag === "Failure") expect(absent.failure.message).toContain("branch not found")

        const ambiguous = yield* resolve("feature").pipe(Effect.result)
        expect(ambiguous._tag).toBe("Failure")
        if (ambiguous._tag === "Failure") expect(ambiguous.failure.message).toContain("ambiguous remote branch")

        const symbolic = yield* resolve("origin/HEAD").pipe(Effect.result)
        expect(symbolic._tag).toBe("Failure")
        if (symbolic._tag === "Failure") expect(symbolic.failure.message).toContain("branch not found")

        git(repo, "branch", "--track", "feature", "upstream/feature")
        const conflicting = yield* resolve("origin/feature").pipe(Effect.result)
        expect(conflicting._tag).toBe("Failure")
        if (conflicting._tag === "Failure")
          expect(conflicting.failure.message).toContain("tracks refs/remotes/upstream/feature")

        const resolved = yield* resolve("feature")
        expect(resolved).toEqual({ branch: "feature", remote: "upstream", remoteRef: "upstream/feature" })
        expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main")
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "exact slash-containing local names are not stripped as remote prefixes",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { repo } = yield* Fixture
        const repositories = yield* Repositories
        git(repo, "branch", "origin/feature")
        const resolved = yield* repositories.resolveExistingBranch(AbsolutePath.make(repo), "origin/feature")
        expect(resolved).toEqual({ branch: "origin/feature" })
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "an existing remote selection leaves dirty in-place work and occupied branches alone",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { repo, tmp } = yield* Fixture
        const repositories = yield* Repositories
        yield* Effect.promise(() => writeFile(join(repo, "wip.txt"), "work\n"))
        const outcome = yield* repositories.provisionInPlace({
          source: AbsolutePath.make(repo),
          branch: "origin/feature",
          createMissing: false,
        })
        expect(outcome).toBe("skipped-dirty")
        expect(git(repo, "branch", "--list", "feature")).toBe("")
        expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main")
        git(repo, "branch", "--track", "feature", "origin/feature")
        git(repo, "worktree", "add", join(tmp, "occupied"), "feature")
        const rejected = yield* repositories
          .provisionLinkedWorktree({
            source: AbsolutePath.make(repo),
            directory: AbsolutePath.make(join(tmp, "second")),
            branch: "origin/feature",
            createMissing: false,
          })
          .pipe(Effect.result)
        expect(rejected._tag).toBe("Failure")
        expect(existsSync(join(tmp, "second"))).toBe(false)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "provisionInPlace creates the branch in place and leaves a dirty checkout alone",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { makeRepo } = yield* Fixture
        const repositories = yield* Repositories
        const dir = yield* Effect.promise(() => makeRepo("inplace-repo"))
        const created = yield* repositories.provisionInPlace({
          source: AbsolutePath.make(dir),
          branch: "feature",
          createMissing: true,
        })
        expect(created).toBe("created")
        expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("feature")

        const again = yield* repositories.provisionInPlace({
          source: AbsolutePath.make(dir),
          branch: "feature",
          createMissing: true,
        })
        expect(again).toBe("already")

        const dirtyDir = yield* Effect.promise(() => makeRepo("inplace-dirty-repo"))
        yield* Effect.promise(() => writeFile(join(dirtyDir, "wip.txt"), "x\n"))
        const dirty = yield* repositories.provisionInPlace({
          source: AbsolutePath.make(dirtyDir),
          branch: "feature",
          createMissing: true,
        })
        expect(dirty).toBe("skipped-dirty")
      }),
    ),
  TEST_TIMEOUT_MS,
)
