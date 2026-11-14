import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { AbsolutePath } from "@corvi/contracts/paths"
import { Repositories, layer as repositoriesLayer, type CapturedWork } from "../src/repositories.ts"
import { layer as commandLayer } from "../src/node/command.ts"
import { layer as gitLayer } from "../src/node/git.ts"
import { Fixture, git, runScoped, sandboxLayer } from "./sandbox.ts"

const EFFECT_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 90_000

const nodeLayer: Layer.Layer<Repositories> = repositoriesLayer.pipe(
  Layer.provide(gitLayer.pipe(Layer.provide(commandLayer))),
)

const withRepositories = <A, E>(program: Effect.Effect<A, E, Fixture | Repositories>): Promise<A> =>
  runScoped(program, Layer.merge(sandboxLayer, nodeLayer), EFFECT_TIMEOUT_MS)

/** Bytes no text diff could carry: a NUL and every high byte. */
const BINARY = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 128, 7])

const captured = (work: CapturedWork): Extract<CapturedWork, { _tag: "Captured" }> => {
  if (work._tag !== "Captured") throw new Error(`expected captured work, got ${work._tag}`)
  return work
}

/** A checkout with every kind of uncommitted work: a staged edit, an unstaged edit, a deletion,
 * an untracked text file in a new directory, an untracked binary — and an ignored file, which a
 * shelf never holds. */
const dirtyCheckout = async (repo: string): Promise<void> => {
  await writeFile(join(repo, ".gitignore"), "build/\n")
  await writeFile(join(repo, "b.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n")
  await writeFile(join(repo, "gone.txt"), "soon gone\n")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "more files")
  await writeFile(join(repo, "a.txt"), "a staged\n")
  git(repo, "add", "a.txt")
  await writeFile(join(repo, "b.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight edited\n")
  git(repo, "rm", "--quiet", "gone.txt")
  await mkdir(join(repo, "notes"), { recursive: true })
  await writeFile(join(repo, "notes", "idea with spaces.md"), "an idea\n")
  await writeFile(join(repo, "image.bin"), BINARY)
  await mkdir(join(repo, "build"), { recursive: true })
  await writeFile(join(repo, "build", "out.js"), "ignored\n")
}

test(
  "captured work is discarded, then applies back exactly — untracked and binary files included, ignored files untouched",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        yield* Effect.promise(() => dirtyCheckout(repo))
        const directory = AbsolutePath.make(repo)
        const patchFile = AbsolutePath.make(join(tmp, "work.patch"))
        const head = git(repo, "rev-parse", "HEAD")

        const work = captured(yield* repositories.captureWork({ directory, patchFile }))
        expect(work.base).toBe(head)
        expect(work.branch).toBe("main")
        expect(work.patchBytes).toBeGreaterThan(0)
        expect(work.files.map((file) => [file.path, file.change])).toEqual([
          ["a.txt", "modified"],
          ["b.txt", "modified"],
          ["gone.txt", "deleted"],
          ["image.bin", "untracked"],
          ["notes/idea with spaces.md", "untracked"],
        ])
        expect(work.files.find((file) => file.path === "image.bin")?.bytes).toBe(BINARY.length)
        // Capturing touched neither the index nor the files.
        expect(git(repo, "diff", "--cached", "--name-only")).toContain("a.txt")
        expect(existsSync(join(repo, "image.bin"))).toBe(true)

        expect(yield* repositories.discardWork({ directory, patchFile, files: work.files })).toEqual({
          _tag: "Discarded",
        })
        expect(git(repo, "status", "--porcelain")).toBe("")
        expect(existsSync(join(repo, "notes", "idea with spaces.md"))).toBe(false)
        expect(yield* Effect.promise(() => readFile(join(repo, "build", "out.js"), "utf8"))).toBe("ignored\n")

        expect(yield* repositories.applyWork({ directory, patchFile })).toEqual({ _tag: "Applied" })
        expect(yield* Effect.promise(() => readFile(join(repo, "a.txt"), "utf8"))).toBe("a staged\n")
        expect(yield* Effect.promise(() => readFile(join(repo, "b.txt"), "utf8"))).toContain("eight edited")
        expect(existsSync(join(repo, "gone.txt"))).toBe(false)
        expect(yield* Effect.promise(() => readFile(join(repo, "image.bin")))).toEqual(BINARY)
        expect(yield* Effect.promise(() => readFile(join(repo, "notes", "idea with spaces.md"), "utf8"))).toBe(
          "an idea\n",
        )
        // The work comes back as working-tree changes: nothing staged, new files untracked again.
        expect(git(repo, "diff", "--cached", "--name-only")).toBe("")
        expect(git(repo, "diff", "--name-status", "--no-renames").split("\n")).toEqual([
          "M\ta.txt",
          "M\tb.txt",
          "D\tgone.txt",
        ])
        expect(git(repo, "ls-files", "--others", "--exclude-standard").split("\n")).toEqual([
          "image.bin",
          "notes/idea with spaces.md",
        ])
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "a clean checkout has nothing to capture",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const work = yield* repositories.captureWork({
          directory: AbsolutePath.make(repo),
          patchFile: AbsolutePath.make(join(tmp, "work.patch")),
        })
        expect(work).toEqual({ _tag: "Clean" })
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "work that changed after it was captured is not discarded",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const directory = AbsolutePath.make(repo)
        const patchFile = AbsolutePath.make(join(tmp, "work.patch"))
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "edited\n"))
        const work = captured(yield* repositories.captureWork({ directory, patchFile }))

        // A new file appeared after the capture.
        yield* Effect.promise(() => writeFile(join(repo, "late.txt"), "late\n"))
        const added = yield* repositories.discardWork({ directory, patchFile, files: work.files })
        expect(added._tag).toBe("Changed")
        expect(existsSync(join(repo, "late.txt"))).toBe(true)

        // The captured file itself was edited again.
        git(repo, "clean", "--force", "--quiet", "--", "late.txt")
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "edited twice\n"))
        const edited = yield* repositories.discardWork({ directory, patchFile, files: work.files })
        expect(edited._tag).toBe("Changed")
        expect(yield* Effect.promise(() => readFile(join(repo, "a.txt"), "utf8"))).toBe("edited twice\n")
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "applying onto a moved branch merges three-way, and a real conflict is left marked",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const directory = AbsolutePath.make(repo)
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n"))
        git(repo, "commit", "--quiet", "-am", "lines")

        // Shelve an edit at the end of the file.
        const patchFile = AbsolutePath.make(join(tmp, "end.patch"))
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9 shelved\n"))
        const work = captured(yield* repositories.captureWork({ directory, patchFile }))
        yield* repositories.discardWork({ directory, patchFile, files: work.files })

        // The branch moves on at the start of the same file.
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "1 moved\n2\n3\n4\n5\n6\n7\n8\n9\n"))
        git(repo, "commit", "--quiet", "-am", "moved on")
        expect(yield* repositories.applyWork({ directory, patchFile })).toEqual({ _tag: "Applied" })
        expect(yield* Effect.promise(() => readFile(join(repo, "a.txt"), "utf8"))).toBe(
          "1 moved\n2\n3\n4\n5\n6\n7\n8\n9 shelved\n",
        )
        git(repo, "checkout", "--quiet", "--", "a.txt")

        // Now the branch changes the very line the shelf changes.
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "1 moved\n2\n3\n4\n5\n6\n7\n8\n9 committed\n"))
        git(repo, "commit", "--quiet", "-am", "same line")
        const conflict = yield* repositories.applyWork({ directory, patchFile })
        expect(conflict).toEqual({ _tag: "Conflicts", files: ["a.txt"] })
        expect(yield* Effect.promise(() => readFile(join(repo, "a.txt"), "utf8"))).toContain("<<<<<<<")
      }),
    ),
  TEST_TIMEOUT_MS,
)

test(
  "captured work is never applied over uncommitted work, and a conflicted checkout is not captured",
  () =>
    withRepositories(
      Effect.gen(function* () {
        const { tmp, repo } = yield* Fixture
        const repositories = yield* Repositories
        const directory = AbsolutePath.make(repo)
        const patchFile = AbsolutePath.make(join(tmp, "work.patch"))
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "shelved\n"))
        const work = captured(yield* repositories.captureWork({ directory, patchFile }))
        yield* repositories.discardWork({ directory, patchFile, files: work.files })

        yield* Effect.promise(() => writeFile(join(repo, "other.txt"), "in the way\n"))
        expect(yield* repositories.applyWork({ directory, patchFile })).toEqual({
          _tag: "NotClean",
          files: ["other.txt"],
        })
        expect(yield* Effect.promise(() => readFile(join(repo, "a.txt"), "utf8"))).toBe("a\n")

        // A merge in progress with a conflict: resolve it first.
        git(repo, "clean", "--force", "--quiet")
        git(repo, "switch", "--quiet", "-c", "side")
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "side\n"))
        git(repo, "commit", "--quiet", "-am", "side")
        git(repo, "switch", "--quiet", "main")
        yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "main\n"))
        git(repo, "commit", "--quiet", "-am", "main")
        try {
          git(repo, "merge", "--quiet", "side")
        } catch {
          // The conflict is the point.
        }
        const conflicted = yield* repositories.captureWork({ directory, patchFile })
        expect(conflicted).toEqual({ _tag: "Conflicted", files: ["a.txt"] })
      }),
    ),
  TEST_TIMEOUT_MS,
)
