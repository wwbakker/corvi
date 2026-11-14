import { afterAll, beforeAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"

import { ChangeRepositories } from "@corvi/changes/repositories"
import { ChangeService } from "@corvi/changes/changes"
import { layer as changesNodeLayer, shelvesLayer, storeLayer } from "@corvi/changes/node"
import { ChangeId, DirectoryName } from "@corvi/contracts/changes"
import { SHELF_WARNING_BYTES } from "@corvi/contracts/shelves"
import { layer as repositoriesNodeLayer } from "@corvi/repositories/node"
import { ChangeShelves, layer as shelvesWorkflowLayer } from "../src/shelves.ts"

let base: string

beforeAll(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-shelves-`))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim()

/** A change with one repository used in place, so its checkout is a plain repository. */
const world = async (
  name: string,
): Promise<{ readonly layer: Layer.Layer<ChangeShelves | ChangeService | ChangeRepositories>; readonly repo: string }> => {
  const roots = [{ root: join(base, name, "changes"), archiveRoot: join(base, name, "archive") }]
  const repo = join(base, name, "api")
  execFileSync("git", ["init", "--quiet", "-b", "main", repo])
  await writeFile(join(repo, "a.txt"), "a\n")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "init")
  const store = storeLayer({ roots })
  const services = changesNodeLayer.pipe(Layer.provide(store))
  const layer = Layer.merge(
    shelvesWorkflowLayer.pipe(
      Layer.provide(services),
      Layer.provide(repositoriesNodeLayer),
      Layer.provide(shelvesLayer({ roots })),
    ),
    services,
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const links = yield* ChangeRepositories
      yield* changes.createChange({ changeId: ChangeId.make(name), title: name, workspaceLocation: "" })
      yield* links.addRepository({
        changeId: ChangeId.make(name),
        originalLocation: repo,
        location: "original",
        branch: { kind: "current" },
      })
    }).pipe(Effect.provide(layer)),
  )
  return { layer, repo }
}

test("shelving puts the work aside and leaves the checkout clean; applying puts it back and removes the shelf", async () => {
  const { layer, repo } = await world("roundtrip")
  const changeId = ChangeId.make("roundtrip")
  await writeFile(join(repo, "a.txt"), "edited\n")
  await writeFile(join(repo, "new.txt"), "new\n")
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const shelves = yield* ChangeShelves
      const shelved = yield* shelves.shelveRepository({ changeId, repository: DirectoryName.make("api"), reason: "manual" })
      const listed = yield* shelves.listShelves(changeId)
      const patch = listed[0] ? yield* shelves.readShelfPatch({ changeId, shelfId: listed[0].id }) : ""
      const clean = git(repo, "status", "--porcelain")
      const applied = listed[0] ? yield* shelves.applyShelf({ changeId, shelfId: listed[0].id }) : undefined
      return { shelved, listed, patch, clean, applied, after: yield* shelves.listShelves(changeId) }
    }).pipe(Effect.provide(layer)),
  )
  expect(outcome.shelved._tag).toBe("Shelved")
  expect(outcome.listed.map((shelf) => [String(shelf.repository), shelf.reason, shelf.files.map((file) => file.path)])).toEqual([
    ["api", "manual", ["a.txt", "new.txt"]],
  ])
  expect(outcome.listed[0]?.name).toMatch(/^Shelved \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  expect(outcome.patch).toContain("+edited")
  expect(outcome.clean).toBe("")
  expect(outcome.applied).toEqual({ _tag: "Applied" })
  expect(outcome.after).toEqual([])
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("edited\n")
  expect(await readFile(join(repo, "new.txt"), "utf8")).toBe("new\n")
})

test("a clean checkout leaves no shelf behind, and a cancel shelf is the one restored", async () => {
  const { layer, repo } = await world("restore")
  const changeId = ChangeId.make("restore")
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const shelves = yield* ChangeShelves
      const clean = yield* shelves.shelveRepository({ changeId, repository: DirectoryName.make("api"), reason: "manual" })
      yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "by hand\n"))
      yield* shelves.shelveRepository({ changeId, repository: DirectoryName.make("api"), reason: "manual", name: "mine" })
      yield* Effect.promise(() => writeFile(join(repo, "a.txt"), "at cancel\n"))
      yield* shelves.shelveRepository({ changeId, repository: DirectoryName.make("api"), reason: "cancel" })
      const restored = yield* shelves.restoreCancelShelves(changeId)
      return { clean, restored, left: yield* shelves.listShelves(changeId) }
    }).pipe(Effect.provide(layer)),
  )
  expect(outcome.clean).toEqual({ _tag: "Clean" })
  expect(outcome.restored.map((entry) => [String(entry.repository), entry.outcome._tag])).toEqual([["api", "Applied"]])
  expect(outcome.left.map((shelf) => shelf.name)).toEqual(["mine"])
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("at cancel\n")
})

test("a shelf above the warning size is only made when asked again, and nothing changes before", async () => {
  const { layer, repo } = await world("large")
  const changeId = ChangeId.make("large")
  // Random bytes do not compress: the binary patch is bigger than the file.
  await writeFile(join(repo, "dump.bin"), randomBytes(Math.ceil(SHELF_WARNING_BYTES * 0.85)))
  await writeFile(join(repo, "small.txt"), "small\n")
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const shelves = yield* ChangeShelves
      const first = yield* shelves.shelveRepository({ changeId, repository: DirectoryName.make("api"), reason: "manual" })
      const stillThere = existsSync(join(repo, "dump.bin"))
      const listed = yield* shelves.listShelves(changeId)
      const second = yield* shelves.shelveRepository({
        changeId,
        repository: DirectoryName.make("api"),
        reason: "manual",
        allowLarge: true,
      })
      return { first, stillThere, listed, second }
    }).pipe(Effect.provide(layer)),
  )
  expect(outcome.first._tag).toBe("TooLarge")
  if (outcome.first._tag === "TooLarge") expect(outcome.first.largest[0]?.path).toBe("dump.bin")
  expect(outcome.stillThere).toBe(true)
  expect(outcome.listed).toEqual([])
  expect(outcome.second._tag).toBe("Shelved")
  expect(existsSync(join(repo, "dump.bin"))).toBe(false)
}, 60_000)
