import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer } from "effect"

import {
  ChangeId,
  DirectoryName,
  RepositoryId,
  type Change,
  type Repository,
} from "@corvi/contracts/changes"
import { ChangeService } from "../src/changes.ts"
import { ChangeStore } from "../src/store.ts"
import { ChangeRepositories } from "../src/change-repositories.ts"
import type {
  ChangeFormatTooNew,
  ChangeIdTaken,
  ChangeStoreError,
  DuplicateDirectoryName,
  RepositoryStoreError,
} from "../src/errors.ts"
import { layer as servicesLayer, migrateStoredRecords, storeLayer } from "../src/node/index.ts"

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-changes-`))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const services = (at: string): Layer.Layer<ChangeService | ChangeRepositories> =>
  servicesLayer.pipe(Layer.provide(storeLayer({ roots: [{ root: at, archiveRoot: `${at}-archive` }] })))

const runEither = <A, E>(
  program: Effect.Effect<A, E, ChangeService | ChangeRepositories>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(program.pipe(Effect.either, Effect.provide(services(root))))

const create = (
  id: string,
): Effect.Effect<Change, ChangeIdTaken | ChangeStoreError, ChangeService> =>
  Effect.gen(function* () {
    const changes = yield* ChangeService
    return yield* changes.createChange({
      changeId: ChangeId.make(id),
      title: `Change ${id}`,
      workspaceLocation: `/workspace/${id}`,
    })
  })

const addRepository = (
  id: string,
  directoryName: string,
  input: {
    readonly location?: Repository["location"]
    readonly branch?: Repository["branch"]
    readonly base?: string
    readonly target?: string
  } = {},
): Effect.Effect<
  Repository,
  ChangeFormatTooNew | DuplicateDirectoryName | RepositoryStoreError,
  ChangeRepositories
> =>
  Effect.gen(function* () {
    const links = yield* ChangeRepositories
    return yield* links.addRepository({
      changeId: ChangeId.make(id),
      originalLocation: `/sources/${directoryName}`,
      location: input.location ?? "new",
      branch: input.branch ?? { kind: "change" },
      ...(input.base !== undefined ? { base: input.base } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
    })
  })

test("a created change round-trips and lists as active", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const created = yield* changes.createChange({
        changeId: ChangeId.make("roundtrip"),
        title: "Round trip",
        workspaceLocation: "/workspace/roundtrip",
      })
      const read = yield* changes.getChange(ChangeId.make("roundtrip"))
      const active = yield* changes.listChanges("Active")
      return { created, read, active }
    }).pipe(Effect.provide(services(root))),
  )
  expect(result.created.branch).toBe("roundtrip")
  expect(result.created.phase).toBe("Ideation")
  expect(result.read).toEqual(result.created)
  expect(result.active.map((change) => change.changeId)).toContain(ChangeId.make("roundtrip"))
})

test("a duplicate change id is refused", async () => {
  await Effect.runPromise(create("duplicate").pipe(Effect.provide(services(root))))
  const result = await runEither(create("duplicate"))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("ChangeIdTaken")
})

test("transitions follow the rules and terminal phases set completedAt", async () => {
  await Effect.runPromise(create("lifecycle").pipe(Effect.provide(services(root))))

  const invalid = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.transitionTo(ChangeId.make("lifecycle"), "Verification")
    }),
  )
  expect(Either.isLeft(invalid)).toBe(true)
  if (Either.isLeft(invalid)) expect(invalid.left._tag).toBe("InvalidTransition")

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      const started = yield* changes.transitionTo(ChangeId.make("lifecycle"), "Implementation")
      const completed = yield* changes.transitionTo(ChangeId.make("lifecycle"), "Completed")
      const active = yield* changes.listChanges("Active")
      const archived = yield* changes.listChanges("Archived")
      return { started, completed, active, archived }
    }).pipe(Effect.provide(services(root))),
  )
  expect(result.started.phase).toBe("Implementation")
  expect(result.completed.phase).toBe("Completed")
  expect(result.completed.completedAt).toBeDefined()
  expect(result.active.map((change) => change.changeId)).not.toContain(ChangeId.make("lifecycle"))
  expect(result.archived.map((change) => change.changeId)).toContain(ChangeId.make("lifecycle"))
})

test("links add, list and remove without touching the change's phase", async () => {
  await Effect.runPromise(create("links").pipe(Effect.provide(services(root))))
  await Effect.runPromise(addRepository("links", "first").pipe(Effect.provide(services(root))))
  await Effect.runPromise(addRepository("links", "second").pipe(Effect.provide(services(root))))

  const listed = await Effect.runPromise(
    Effect.gen(function* () {
      const links = yield* ChangeRepositories
      return yield* links.listRepositories(ChangeId.make("links"))
    }).pipe(Effect.provide(services(root))),
  )
  expect(listed.map((repository) => repository.directoryName)).toEqual([
    DirectoryName.make("first"),
    DirectoryName.make("second"),
  ])

  const removed = await Effect.runPromise(
    Effect.gen(function* () {
      const links = yield* ChangeRepositories
      yield* links.removeRepository({
        changeId: ChangeId.make("links"),
        repositoryId: listed[0]!.repositoryId,
      })
      return yield* links.listRepositories(ChangeId.make("links"))
    }).pipe(Effect.provide(services(root))),
  )
  expect(removed.map((repository) => repository.directoryName)).toEqual([DirectoryName.make("second")])
})

test("a duplicate directory name is refused", async () => {
  await Effect.runPromise(create("duplicate-name").pipe(Effect.provide(services(root))))
  await Effect.runPromise(addRepository("duplicate-name", "repo").pipe(Effect.provide(services(root))))
  const result = await runEither(addRepository("duplicate-name", "repo"))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("DuplicateDirectoryName")
})

test("removing an unknown link is refused", async () => {
  await Effect.runPromise(create("unknown-link").pipe(Effect.provide(services(root))))
  const result = await runEither(
    Effect.gen(function* () {
      const links = yield* ChangeRepositories
      return yield* links.removeRepository({
        changeId: ChangeId.make("unknown-link"),
        repositoryId: RepositoryId.make("missing"),
      })
    }),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("RepositoryNotFound")
})

test("adding a link to an unknown change is a store error", async () => {
  const result = await runEither(addRepository("no-such-change", "repo"))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("RepositoryStoreError")
})

test("links survive a phase transition and a fresh store layer", async () => {
  await Effect.runPromise(create("survives").pipe(Effect.provide(services(root))))
  await Effect.runPromise(addRepository("survives", "kept").pipe(Effect.provide(services(root))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      yield* changes.transitionTo(ChangeId.make("survives"), "Implementation")
    }).pipe(Effect.provide(services(root))),
  )
  const links = await Effect.runPromise(
    Effect.gen(function* () {
      const repositories = yield* ChangeRepositories
      return yield* repositories.listRepositories(ChangeId.make("survives"))
    }).pipe(Effect.provide(services(root))),
  )
  expect(links.map((repository) => repository.directoryName)).toEqual([DirectoryName.make("kept")])
})

test("a malformed record is a typed store error, not absence", async () => {
  const id = ChangeId.make("malformed")
  const brokenRoot = join(root, "broken-store")
  await Bun.write(join(brokenRoot, id, "change.json"), "{ not json }\n")
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.getChange(id)
    }).pipe(Effect.either, Effect.provide(services(brokenRoot))),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("ChangeStoreError")
})

test("a transition to an unknown change is ChangeNotFound", async () => {
  const result = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.transitionTo(ChangeId.make("absent"), "Implementation")
    }),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("ChangeNotFound")
})

test("links persist as checkout specs with the record format stamped", async () => {
  await Effect.runPromise(create("materialize").pipe(Effect.provide(services(root))))
  await Effect.runPromise(addRepository("materialize", "one").pipe(Effect.provide(services(root))))
  await Effect.runPromise(
    addRepository("materialize", "two", {
      location: "original",
      branch: { kind: "existing", name: "feature" },
    }).pipe(Effect.provide(services(root))),
  )
  const record = (await Bun.file(join(root, "materialize", "change.json")).json()) as {
    formatVersion?: number
    checkouts?: unknown[]
    state?: string
  }
  expect(record.formatVersion).toBe(2)
  expect(record.checkouts).toHaveLength(2)
  expect(record.checkouts).toContainEqual({ path: "/sources/one", location: "new", branch: { kind: "change" } })
  expect(record.checkouts).toContainEqual({
    path: "/sources/two",
    location: "original",
    branch: { kind: "existing", name: "feature" },
  })
  expect(record.state).toBe("Ideation")
})

test("a terminal transition archives the record and it still reads", async () => {
  await Effect.runPromise(create("archived").pipe(Effect.provide(services(root))))
  const { read, archived } = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      yield* changes.transitionTo(ChangeId.make("archived"), "Implementation")
      yield* changes.transitionTo(ChangeId.make("archived"), "Completed")
      return {
        read: yield* changes.getChange(ChangeId.make("archived")),
        archived: yield* changes.listChanges("Archived"),
      }
    }).pipe(Effect.provide(services(root))),
  )
  expect(archived.map((change) => change.changeId)).toContain(ChangeId.make("archived"))
  expect(read.completedAt).toBeDefined()
  expect(await Bun.file(join(root, "archived", "change.json")).exists()).toBe(false)
  expect(await Bun.file(join(`${root}-archive`, "archived", "change.json")).exists()).toBe(true)
})

test("a format-1 record is migrated on read and persisted as format 2", async () => {
  const legacyRoot = join(root, "legacy-read")
  const path = join(legacyRoot, "migrated", "change.json")
  await Bun.write(
    path,
    JSON.stringify(
      {
        id: "migrated",
        title: "Migrated",
        branch: "migrated",
        state: "In Progress",
        createdAt: "2026-01-01T00:00:00.000Z",
        repos: ["/sources/one", "/sources/two"],
        direct: ["/sources/two"],
        base: { "/sources/two": "feature" },
        repositories: [{ stale: true }],
      },
      null,
      2,
    ) + "\n",
  )
  const links = await Effect.runPromise(
    Effect.gen(function* () {
      const repositories = yield* ChangeRepositories
      return yield* repositories.listRepositories(ChangeId.make("migrated"))
    }).pipe(Effect.provide(services(legacyRoot))),
  )
  expect(links.map((link) => link.originalLocation)).toEqual(["/sources/one", "/sources/two"])
  expect(links[0]?.location).toBe("new")
  expect(links[1]?.location).toBe("original")
  expect(links[1]?.base).toBe("feature")
  expect(links[1]?.target).toBe("feature")
  const record = (await Bun.file(path).json()) as Record<string, unknown>
  expect(record.formatVersion).toBe(2)
  expect(record.state).toBe("Implementation")
  expect("repos" in record).toBe(false)
  expect("repositories" in record).toBe(false)
})

test("the startup sweep migrates once and is idempotent", async () => {
  const sweepRoot = join(root, "sweep")
  const path = join(sweepRoot, "swept", "change.json")
  await Bun.write(
    path,
    JSON.stringify({ id: "swept", state: "Awaiting Review", createdAt: "2026-01-01", repos: ["/sources/one"] }) +
      "\n",
  )
  await Effect.runPromise(migrateStoredRecords({ roots: [{ root: sweepRoot, archiveRoot: `${sweepRoot}-archive` }] }))
  const once = await Bun.file(path).text()
  expect(JSON.parse(once).formatVersion).toBe(2)
  expect(JSON.parse(once).state).toBe("Verification")
  await Effect.runPromise(migrateStoredRecords({ roots: [{ root: sweepRoot, archiveRoot: `${sweepRoot}-archive` }] }))
  expect(await Bun.file(path).text()).toBe(once)
})

test("a record from a newer Corvi reads best-effort and refuses every write", async () => {
  const fencedRoot = join(root, "fenced")
  const path = join(fencedRoot, "newer", "change.json")
  await Bun.write(
    path,
    JSON.stringify({
      id: "newer",
      title: "Newer",
      branch: "newer",
      state: "Ideation",
      createdAt: "2026-01-01T00:00:00.000Z",
      formatVersion: 3,
      checkouts: [{ path: "/sources/one", location: "new", branch: { kind: "change" } }],
    }) + "\n",
  )
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.getChange(ChangeId.make("newer"))
    }).pipe(Effect.provide(services(fencedRoot))),
  )
  expect(read.title).toBe("Newer")

  const refused = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.transitionTo(ChangeId.make("newer"), "Implementation")
    }).pipe(Effect.either, Effect.provide(services(fencedRoot))),
  )
  expect(Either.isLeft(refused)).toBe(true)
  if (Either.isLeft(refused)) expect(refused.left._tag).toBe("ChangeFormatTooNew")

  const linkRefused = await Effect.runPromise(
    addRepository("newer", "more").pipe(Effect.either, Effect.provide(services(fencedRoot))),
  )
  expect(Either.isLeft(linkRefused) && linkRefused.left._tag).toBe("ChangeFormatTooNew")
  // The refusal is the sentence the page shows, not just the tag.
  if (Either.isLeft(refused) && refused.left._tag === "ChangeFormatTooNew") {
    expect(refused.left.message).toContain("newer version of Corvi")
  }
  // Nothing was written: the record a newer Corvi left is exactly as it was.
  expect(JSON.parse(await Bun.file(path).text()).formatVersion).toBe(3)
})

const runStore = <A, E>(program: Effect.Effect<A, E, ChangeStore>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(
    program.pipe(Effect.either, Effect.provide(storeLayer({ roots: [{ root, archiveRoot: `${root}-archive` }] }))),
  )

test("a write moves the revision, and a stale writer is refused", async () => {
  const created = await Effect.runPromise(create("revisioned").pipe(Effect.provide(services(root))))
  expect(created.revision).toBe(1)

  const first = await Effect.runPromise(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.transitionTo(ChangeId.make("revisioned"), "Implementation")
    }).pipe(Effect.provide(services(root))),
  )
  expect(first.revision).toBe(2)

  // A writer that read revision 1 is refused once revision 2 exists: the record it decided on
  // is not the record on disk.
  const stale = await runStore(
    Effect.gen(function* () {
      const store = yield* ChangeStore
      return yield* store.patch(ChangeId.make("revisioned"), {
        phase: "Verification",
        expectedRevision: 1,
      })
    }),
  )
  expect(Either.isLeft(stale) && stale.left._tag).toBe("ChangeConflict")
  if (Either.isLeft(stale) && stale.left._tag === "ChangeConflict") {
    expect(stale.left.expected).toBe(1)
    expect(stale.left.actual).toBe(2)
    // The sentence the user sees, not just the tag: an empty one renders as the type name.
    expect(stale.left.message).toContain("revision")
  }
})

test("concurrent transitions cannot both win", async () => {
  await Effect.runPromise(create("racy").pipe(Effect.provide(services(root))))
  const outcomes = await Effect.runPromise(
    Effect.forEach(
      [1, 2, 3, 4],
      () =>
        Effect.gen(function* () {
          const changes = yield* ChangeService
          return yield* changes.transitionTo(ChangeId.make("racy"), "Implementation")
        }).pipe(Effect.either),
      { concurrency: "unbounded" },
    ).pipe(Effect.provide(services(root))),
  )
  expect(outcomes.filter((outcome) => Either.isRight(outcome))).toHaveLength(1)
  // The losers read the same revision (conflict) or read the winner's phase (invalid).
  for (const outcome of outcomes.filter((outcome) => Either.isLeft(outcome))) {
    expect(["ChangeConflict", "InvalidTransition"]).toContain((outcome.left as { _tag: string })._tag)
  }
  const read = await runEither(
    Effect.gen(function* () {
      const changes = yield* ChangeService
      return yield* changes.getChange(ChangeId.make("racy"))
    }),
  )
  expect(Either.isRight(read) && read.right.phase).toBe("Implementation")
})
