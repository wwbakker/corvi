import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Result } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import { Repositories, layer as repositoriesLayer } from "../src/repositories.ts"
import { layer as commandLayer } from "../src/node/command.ts"
import { layer as gitLayer } from "../src/node/git.ts"
import { Fixture, git, runScoped, sandboxLayer } from "./sandbox.ts"

/** The review tab's git work — local changes, diffs, committing chosen paths, pushing — against
 * real repositories. */
const EFFECT_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 90_000

const nodeLayer: Layer.Layer<Repositories> = repositoriesLayer.pipe(
  Layer.provide(gitLayer.pipe(Layer.provide(commandLayer))),
)

const withRepositories = <A, E>(program: Effect.Effect<A, E, Fixture | Repositories>): Promise<A> =>
  runScoped(program, Layer.merge(sandboxLayer, nodeLayer), EFFECT_TIMEOUT_MS)

/** A bare remote for `repo`, so pushing has somewhere to go. */
const withRemote = (tmp: string, repo: string): string => {
  const remote = join(tmp, "remote.git")
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote])
  git(repo, "remote", "set-url", "origin", remote)
  git(repo, "push", "--quiet", "origin", "main")
  return remote
}

test(
  "local changes list both halves of each path, and the branch's standing against its upstream",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const directory = AbsolutePath.make(repo)
        withRemote(tmp, repo)
        git(repo, "switch", "--quiet", "-c", "feature")

        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "staged\n"))
        git(repo, "add", "a.txt")
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "staged\nand more\n"))
        yield* Effect.promise(() => mkdir(join(repo, "new dir"), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(repo, "new dir", "b.txt"), "new\n"))

        const local = yield* repositories.inspectLocalChanges(directory)
        // Never pushed: no upstream, so "ahead" says nothing rather than zero.
        expect(local.upstream).toBe(false)
        expect(local.ahead).toBeUndefined()
        expect(local.files).toEqual([
          { path: "a.txt", index: "M", worktree: "M", staged: true, unstaged: true, untracked: false },
          { path: "new dir/b.txt", index: "?", worktree: "?", staged: false, unstaged: false, untracked: true },
        ])

        // The diffs are of one half or the other, and an untracked file is diffed against nothing.
        expect(yield* repositories.diffFile({ directory, path: "a.txt", staged: true, untracked: false })).not.toContain(
          "+and more",
        )
        expect(yield* repositories.diffFile({ directory, path: "a.txt", staged: false, untracked: false })).toContain(
          "+and more",
        )
        expect(
          yield* repositories.diffFile({ directory, path: "new dir/b.txt", staged: false, untracked: true }),
        ).toContain("+new")

        // Commits since the base count what a branch with no upstream has that nobody else has.
        git(repo, "commit", "--quiet", "-m", "staged half")
        expect(yield* repositories.countCommitsSince({ directory, from: "origin/main" })).toBe(1)
        expect(yield* repositories.countCommitsSince({ directory, from: "no-such-ref" })).toBe(0)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "committing takes exactly the chosen paths — new files and deletions too — and leaves the rest staged",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { repo } = yield* Fixture
        const repositories = yield* Repositories
        const directory = AbsolutePath.make(repo)
        yield* Effect.promise(() => writeFile(join(repo, "keep-staged.txt"), "mine\n"))
        git(repo, "add", "keep-staged.txt")
        yield* Effect.promise(() => writeFile(join(repo, "new.txt"), "new\n"))
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "edited\n"))

        const committed = yield* repositories.commitPaths({ directory, message: "the chosen two", paths: ["a.txt", "new.txt"] })
        expect(committed.hash).toBe(git(repo, "rev-parse", "--short", "HEAD"))
        expect(git(repo, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([
          "the chosen two",
          "",
          "a.txt",
          "new.txt",
        ])
        expect(git(repo, "diff", "--cached", "--name-only")).toBe("keep-staged.txt")

        // A refusal carries git's words and its exit code.
        const refused = yield* repositories
          .commitPaths({ directory, message: "nothing", paths: ["does-not-exist.txt"] })
          .pipe(Effect.result)
        if (!Result.isFailure(refused) || refused.failure._tag !== "CheckoutError") throw new Error("expected a refusal")
        expect(refused.failure.operation).toBe("commit")
        expect(refused.failure.message).toContain("does-not-exist.txt")
        expect(refused.failure.exitCode).toBeGreaterThan(0)
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "pushing sends the branch the checkout is on and sets its upstream; a refusal says why",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const directory = AbsolutePath.make(repo)
        const remote = withRemote(tmp, repo)
        git(repo, "switch", "--quiet", "-c", "feature")
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "work\n"))
        git(repo, "commit", "--quiet", "-am", "work")

        const pushed = yield* repositories.pushBranch({ directory, fallbackBranch: "unused" })
        expect(pushed.summary).not.toBe("")
        expect(git(remote, "rev-parse", "feature")).toBe(git(repo, "rev-parse", "HEAD"))
        const after = yield* repositories.inspectLocalChanges(directory)
        expect(after).toMatchObject({ upstream: true, ahead: 0 })

        // The remote moved on: a non-fast-forward push is refused, in git's words.
        git(repo, "commit", "--quiet", "--amend", "-m", "rewritten")
        const refused = yield* repositories.pushBranch({ directory, fallbackBranch: "unused" }).pipe(Effect.result)
        if (!Result.isFailure(refused) || refused.failure._tag !== "CheckoutError") throw new Error("expected a refusal")
        expect(refused.failure.operation).toBe("push")
        expect(refused.failure.message).toMatch(/rejected|non-fast-forward|fetch first/)
        expect(refused.failure.exitCode).toBeGreaterThan(0)
      }),
    ),
  TEST_TIMEOUT_MS,
)
