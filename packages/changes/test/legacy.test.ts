import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"

import { ChangeId, DirectoryName, RepositoryId } from "@corvi/contracts/changes"
import { ChangeService } from "../src/changes.ts"
import { ChangeRepositories } from "../src/change-repositories.ts"
import { mapLegacyPhase, projectLegacyChange, projectLegacyRepositories } from "../src/legacy.ts"
import { legacyReadLayer } from "../src/node/index.ts"

const record = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Title ${id}`,
  branch: "branch",
  repos: ["/sources/one", "/sources/two"],
  direct: ["/sources/two"],
  state: "In Progress",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
})

test("legacy phases map onto the new vocabulary", () => {
  expect(mapLegacyPhase("Ideation")).toBe("Ideation")
  expect(mapLegacyPhase("In Progress")).toBe("Implementation")
  expect(mapLegacyPhase("Awaiting Review")).toBe("Verification")
  expect(mapLegacyPhase("Blocked")).toBe("Blocked")
  expect(mapLegacyPhase("Completed")).toBe("Completed")
  expect(mapLegacyPhase("Cancelled")).toBe("Cancelled")
  expect(mapLegacyPhase(undefined)).toBe("Implementation")
})

test("legacy repositories project to links with deterministic ids", () => {
  const links = projectLegacyRepositories({ id: "demo", repos: ["/sources/one", "/sources/two"], direct: ["/sources/two"] })
  expect(links.map((link) => link.repositoryId)).toEqual([RepositoryId.make("demo:one"), RepositoryId.make("demo:two")])
  expect(links.map((link) => link.directoryName)).toEqual([DirectoryName.make("one"), DirectoryName.make("two")])
  expect(links[0]?.checkoutMethod).toBe("UseNewLocationNewBranch")
  expect(links[1]?.checkoutMethod).toBe("UseOriginalLocationNewBranch")
})

test("legacy change projections default the branch and keep the workspace location", () => {
  const change = projectLegacyChange({ id: "demo", createdAt: "2026-01-01T00:00:00.000Z" }, "/changes/demo")
  expect(change.changeId).toBe(ChangeId.make("demo"))
  expect(change.title).toBe("demo")
  expect(change.branch).toBe("demo")
  expect(change.phase).toBe("Implementation")
  expect(change.workspaceLocation).toBe("/changes/demo")
})

let root: string
let archiveRoot: string
let brokenRoot: string

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-legacy-`))
  root = join(base, "changes")
  archiveRoot = join(base, "archive")
  brokenRoot = join(base, "broken-root")
  await mkdir(join(root, "active"), { recursive: true })
  await mkdir(join(archiveRoot, "old"), { recursive: true })
  await Bun.write(join(root, "active", "change.json"), JSON.stringify(record("active"), null, 2) + "\n")
  await Bun.write(
    join(archiveRoot, "old", "change.json"),
    JSON.stringify(record("old", { state: "Completed", completedAt: "2026-02-01T00:00:00.000Z" }), null, 2) + "\n",
  )
  await mkdir(join(brokenRoot, "broken"), { recursive: true })
  await Bun.write(join(brokenRoot, "broken", "change.json"), "{ nope }\n")
  process.env.CORVI_TEST_LEGACY_BASE = base
})

afterAll(async () => {
  const base = process.env.CORVI_TEST_LEGACY_BASE
  if (base) await rm(base, { recursive: true, force: true })
})

const runEither = <A, E>(
  program: Effect.Effect<A, E, ChangeService | ChangeRepositories>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(program.pipe(Effect.either, Effect.provide(legacyReadLayer({ root, archiveRoot }))))

test("the legacy reader serves active and archived changes", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const active = yield* changes.listChanges("Active")
      const archived = yield* changes.listChanges("Archived")
      return { active, archived }
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right.active.map((change) => change.changeId)).toEqual([ChangeId.make("active")])
    expect(result.right.archived.map((change) => change.changeId)).toEqual([ChangeId.make("old")])
  }
})

test("the legacy reader projects links and the change's directory as the workspace", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const links = yield* ChangeRepositories
      const change = yield* changes.getChange(ChangeId.make("active"))
      return { change, repositories: yield* links.listRepositories(ChangeId.make("active")) }
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right.change.workspaceLocation).toBe(join(root, "active"))
    expect(result.right.repositories.map((repository) => repository.directoryName)).toEqual([
      DirectoryName.make("one"),
      DirectoryName.make("two"),
    ])
  }
})

test("a missing legacy change is ChangeNotFound, a malformed one is a store error", async () => {
  const missing = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.getChange(ChangeId.make("absent"))
    }),
  )
  expect(Either.isLeft(missing)).toBe(true)
  if (Either.isLeft(missing)) expect(missing.left._tag).toBe("ChangeNotFound")

  const malformed = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.getChange(ChangeId.make("broken"))
    }).pipe(
      Effect.either,
      Effect.provide(legacyReadLayer({ root: brokenRoot, archiveRoot: brokenRoot })),
    ),
  )
  expect(Either.isLeft(malformed)).toBe(true)
  if (Either.isLeft(malformed)) expect(malformed.left._tag).toBe("ChangeStoreError")
})

test("legacy writes fail explicitly, never as no-ops", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.createChange({
        changeId: ChangeId.make("new"),
        title: "New",
        workspaceLocation: "/changes/new",
      })
    }),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("ChangeStoreError")
    if (result.left._tag === "ChangeStoreError") expect(result.left.message).toContain("read-only")
  }
})
