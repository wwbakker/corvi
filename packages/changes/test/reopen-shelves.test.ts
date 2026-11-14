import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result } from "effect"

import { ChangeId, DirectoryName } from "@corvi/contracts/changes"
import { ShelfId, type ShelfDto } from "@corvi/contracts/shelves"
import { ChangeService } from "../src/changes.ts"
import { ShelfStore } from "../src/shelves.ts"
import type { ChangeRepositories } from "../src/change-repositories.ts"
import { layer as servicesLayer, shelvesLayer, storeLayer } from "../src/node/index.ts"

let base: string

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-reopen-`))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** One test's own roots, so no test sees another's changes. */
const rootsFor = (name: string): { readonly root: string; readonly archiveRoot: string } => ({
  root: join(base, name, "changes"),
  archiveRoot: join(base, name, "archive"),
})

const services = (
  roots: { readonly root: string; readonly archiveRoot: string },
): Layer.Layer<ChangeService | ChangeRepositories | ShelfStore> =>
  Layer.merge(servicesLayer.pipe(Layer.provide(storeLayer({ roots: [roots] }))), shelvesLayer({ roots: [roots] }))

const run = <A, E>(
  roots: { readonly root: string; readonly archiveRoot: string },
  program: Effect.Effect<A, E, ChangeService | ChangeRepositories | ShelfStore>,
): Promise<Result.Result<A, E>> => Effect.runPromise(program.pipe(Effect.result, Effect.provide(services(roots))))

const make = (id: string): Effect.Effect<void, unknown, ChangeService> =>
  Effect.gen(function* () {
    const changes = yield* ChangeService
    yield* changes.createChange({ changeId: ChangeId.make(id), title: id, workspaceLocation: "" })
  })

test("a cancelled change remembers its phase, and reopening brings the directory back in it", async () => {
  const roots = rootsFor("reopen")
  const id = ChangeId.make("parked")
  const result = await run(
    roots,
    Effect.gen(function* () {
      const changes = yield* ChangeService
      yield* make(id)
      yield* changes.transitionTo(id, "Implementation")
      yield* changes.transitionTo(id, "Verification")
      const cancelled = yield* changes.transitionTo(id, "Cancelled")
      const reopened = yield* changes.reopen(id)
      return { cancelled, reopened, read: yield* changes.getChange(id) }
    }),
  )
  if (!Result.isSuccess(result)) throw new Error(String(result.failure))
  const { cancelled, reopened, read } = result.success
  expect(cancelled.cancelledFrom).toBe("Verification")
  expect(reopened.phase).toBe("Verification")
  expect(read.phase).toBe("Verification")
  expect(read.completedAt).toBeUndefined()
  expect(read.cancelledFrom).toBeUndefined()
  expect(read.workspaceLocation).toBe(join(roots.root, "parked"))
  expect(await Bun.file(join(roots.archiveRoot, "parked", "change.json")).exists()).toBe(false)
  const record = JSON.parse(await readFile(join(roots.root, "parked", "change.json"), "utf8")) as Record<string, unknown>
  expect(record.state).toBe("Verification")
  expect("completedAt" in record).toBe(false)
  expect("cancelledFrom" in record).toBe(false)
})

test("a cancelled idea reopens as an idea; a record cancelled without its phase reopens in Implementation", async () => {
  const roots = rootsFor("phases")
  const result = await run(
    roots,
    Effect.gen(function* () {
      const changes = yield* ChangeService
      yield* make("idea")
      yield* changes.transitionTo(ChangeId.make("idea"), "Cancelled")
      return yield* changes.reopen(ChangeId.make("idea"))
    }),
  )
  expect(Result.isSuccess(result) && result.success.phase).toBe("Ideation")

  // Archived by an older Corvi: no `cancelledFrom`.
  await mkdir(join(roots.archiveRoot, "older"), { recursive: true })
  await writeFile(
    join(roots.archiveRoot, "older", "change.json"),
    JSON.stringify({
      id: "older",
      title: "Older",
      branch: "older",
      state: "Cancelled",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
      formatVersion: 2,
      revision: 3,
    }),
  )
  const older = await run(
    roots,
    Effect.flatMap(ChangeService, (changes) => changes.reopen(ChangeId.make("older"))),
  )
  expect(Result.isSuccess(older) && older.success.phase).toBe("Implementation")
})

test("a completed change, or one that is not over, does not reopen", async () => {
  const roots = rootsFor("refused")
  const result = await run(
    roots,
    Effect.gen(function* () {
      const changes = yield* ChangeService
      yield* make("done")
      yield* changes.transitionTo(ChangeId.make("done"), "Implementation")
      yield* changes.transitionTo(ChangeId.make("done"), "Completed")
      yield* make("busy")
      return {
        completed: yield* changes.reopen(ChangeId.make("done")).pipe(Effect.result),
        active: yield* changes.reopen(ChangeId.make("busy")).pipe(Effect.result),
      }
    }),
  )
  if (!Result.isSuccess(result)) throw new Error(String(result.failure))
  const { completed, active } = result.success
  expect(Result.isFailure(completed) && completed.failure._tag).toBe("InvalidTransition")
  expect(Result.isFailure(completed) && completed.failure.message).toContain("only a cancelled change")
  expect(Result.isFailure(active) && active.failure._tag).toBe("InvalidTransition")
})

test("reopening never overwrites a directory left behind in the changes root", async () => {
  const roots = rootsFor("leftover")
  const id = ChangeId.make("blocked")
  await run(
    roots,
    Effect.gen(function* () {
      const changes = yield* ChangeService
      yield* make(id)
      yield* changes.transitionTo(id, "Cancelled")
    }),
  )
  await mkdir(join(roots.root, "blocked", "target"), { recursive: true })
  await writeFile(join(roots.root, "blocked", "target", "out.class"), "build output")
  const result = await run(roots, Effect.flatMap(ChangeService, (changes) => changes.reopen(id)))
  expect(Result.isFailure(result) && result.failure._tag).toBe("ChangeStoreError")
  expect(Result.isFailure(result) && result.failure.message).toContain("Left behind")
  expect(await readFile(join(roots.root, "blocked", "target", "out.class"), "utf8")).toBe("build output")
  expect(await Bun.file(join(roots.archiveRoot, "blocked", "change.json")).exists()).toBe(true)
})

const shelfOf = (id: ShelfId, overrides: Partial<ShelfDto> = {}): ShelfDto => ({
  id,
  repository: DirectoryName.make("api"),
  name: "Half a refactor",
  reason: "manual",
  createdAt: "2026-11-12T10:00:00.000Z",
  branch: "feature",
  base: "abc123",
  files: [{ path: "a.txt", change: "modified", bytes: 4 }],
  patchBytes: 10,
  ...overrides,
})

test("a shelf is listed once recorded, travels into the archive and back, and is removed with its patch", async () => {
  const roots = rootsFor("shelves")
  const id = ChangeId.make("shelving")
  const result = await run(
    roots,
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const shelves = yield* ShelfStore
      yield* make(id)
      const prepared = yield* shelves.prepare({ changeId: id, repository: DirectoryName.make("api"), name: "Half a refactor!" })
      yield* Effect.promise(() => writeFile(prepared.patchFile, "diff --git a/a.txt b/a.txt\n"))
      // Prepared but not recorded: not a shelf yet.
      const before = yield* shelves.list(id)
      yield* shelves.record(id, shelfOf(prepared.id))
      const second = yield* shelves.prepare({ changeId: id, repository: DirectoryName.make("api"), name: "Half a refactor!" })
      yield* changes.transitionTo(id, "Cancelled")
      const archived = yield* shelves.list(id)
      const patch = yield* shelves.readPatch(id, prepared.id)
      yield* changes.reopen(id)
      const back = yield* shelves.find(id, prepared.id)
      yield* shelves.remove(id, prepared.id)
      return { prepared, second, before, archived, patch, back, after: yield* shelves.list(id) }
    }),
  )
  if (!Result.isSuccess(result)) throw new Error(String(result.failure))
  const { prepared, second, before, archived, patch, back, after } = result.success
  expect(prepared.id).toMatch(/^api\/\d{8}T\d{9}Z-half-a-refactor$/)
  expect(second.id).not.toBe(prepared.id)
  expect(before).toEqual([])
  expect(archived.map((shelf) => shelf.id)).toEqual([prepared.id])
  expect(patch).toBe("diff --git a/a.txt b/a.txt\n")
  expect(String(back.patchFile)).toBe(join(roots.root, "shelving", "shelves", prepared.id, "changes.patch"))
  expect(after).toEqual([])
  expect(await Bun.file(back.patchFile).exists()).toBe(false)
})

test("a shelf id that escapes the change's shelves names nothing", async () => {
  const roots = rootsFor("escape")
  const id = ChangeId.make("confined")
  const result = await run(
    roots,
    Effect.gen(function* () {
      const shelves = yield* ShelfStore
      yield* make(id)
      return yield* shelves.find(id, ShelfId.make("../change.json")).pipe(Effect.result)
    }),
  )
  if (!Result.isSuccess(result)) throw new Error(String(result.failure))
  expect(Result.isFailure(result.success) && result.success.failure._tag).toBe("ShelfNotFound")
})
