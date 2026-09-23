/** File-backed change store, record format 2.
 *
 * The record is `<root>/<changeId>/change.json` with `formatVersion: 2`: the change's own
 * fields and one `checkouts` entry per source repository (the same spec the wire carries).
 * A record without `formatVersion` is format 1 and is migrated in place on its next read —
 * atomically, so no record is ever half-migrated. A record written by a newer Corvi is read
 * best-effort and never written: a format this version does not understand must not be
 * flattened into one it does. A phase transition to a terminal phase moves the directory into
 * the archive root of the pair it lives under.
 *
 * The store spans several roots — one pair per settings scope — so a change stays wherever it
 * was made: reads and listing scan every pair, active before archived. Creation lands in the
 * first pair's root (the application creates changes through its own store, which routes by
 * the change's workspace).
 *
 * Writes replace the file atomically (temp file plus rename) and are serialized in-process.
 * Cross-process locking is not provided yet; that is why `ChangeConflict` exists but is not
 * raised here.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, ParseResult, Schema } from "effect"

import { CheckoutSpecSchema } from "@corvi/contracts/api"
import {
  Change,
  ChangeId,
  ChangePhase,
  Repository,
  RepositoryId,
  type AddRepositoryInput,
} from "@corvi/contracts/changes"
import {
  ChangeConflict,
  ChangeFormatTooNew,
  ChangeNotFound,
  ChangeStoreError,
  RepositoryStoreError,
} from "../errors.ts"
import { LegacyChangeRecord, migrateRecord } from "../legacy.ts"
import { FORMAT_VERSION } from "../record.ts"
import { repositoryFromSpec, specFromInput, specFromRepository } from "../rules.ts"
import { ChangeStore } from "../store.ts"

const StoredRecord = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  state: Schema.optional(ChangePhase),
  workspace: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
  formatVersion: Schema.optional(Schema.Number),
  checkouts: Schema.optional(Schema.Array(CheckoutSpecSchema)),
})
type StoredRecord = typeof StoredRecord.Type

/** One settings scope's changes root and archive root. A change lives under one pair and
 * travels to that pair's archive when it is done. */
export type RootPair = { readonly root: string; readonly archiveRoot: string }

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT"

const storeError = (
  operation: "read" | "write",
  message: string,
  cause: unknown,
  changeId?: ChangeId,
): ChangeStoreError => new ChangeStoreError({ operation, message, cause, changeId })

const decodeRecord = (text: string, path: string): Effect.Effect<StoredRecord, ChangeStoreError> =>
  Schema.decodeUnknown(Schema.parseJson(StoredRecord), { onExcessProperty: "preserve" })(text).pipe(
    Effect.mapError((error) => {
      const detail = ParseResult.ArrayFormatter.formatIssueSync(error.issue)
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ")
      return storeError("read", `malformed change record at ${path}: ${detail}`, error)
    }),
  )

interface Located {
  readonly record: StoredRecord
  readonly dir: string
}

export const layer = (options: { readonly roots: readonly RootPair[] }): Layer.Layer<ChangeStore> =>
  Layer.effect(
    ChangeStore,
    Effect.gen(function* () {
      const lock = yield* Effect.makeSemaphore(1)

      const writeAt = (dir: string, record: StoredRecord): Effect.Effect<void, ChangeStoreError> => {
        const path = join(dir, "change.json")
        const temp = `${path}.tmp`
        const attempt = <A>(what: string, work: () => Promise<A>): Effect.Effect<A, ChangeStoreError> =>
          Effect.tryPromise({
            try: work,
            catch: (cause: unknown) => storeError("write", `${what} at ${path}`, cause),
          })
        return Effect.gen(function* () {
          yield* attempt("could not create the change directory", () => mkdir(dir, { recursive: true }))
          yield* attempt("could not write the change record", () => writeFile(temp, JSON.stringify(record, null, 2) + "\n"))
          yield* attempt("could not replace the change record", () => rename(temp, path))
        })
      }

      /** The downgrade fence: a record written by a newer Corvi is read but never written. */
      const writable = (record: StoredRecord): Effect.Effect<void, ChangeFormatTooNew> => {
        const recordFormat = record.formatVersion ?? 1
        return recordFormat > FORMAT_VERSION
          ? Effect.fail(
              new ChangeFormatTooNew({
                changeId: ChangeId.make(record.id),
                recordFormat,
                appFormat: FORMAT_VERSION,
                message:
                  `change ${record.id} was written by a newer version of Corvi ` +
                  `(record format ${recordFormat}, this one writes ${FORMAT_VERSION}); upgrade to edit it`,
              }),
            )
          : Effect.void
      }

      /** Read one record, migrating a format-1 record in place on the way (atomically). A
       * record from a newer Corvi comes back as it decodes best-effort, and is never written.
       * Callers hold the lock: a migration write must not race a patch. */
      const readAt = (dir: string): Effect.Effect<StoredRecord | undefined, ChangeStoreError> =>
        Effect.gen(function* () {
            const path = join(dir, "change.json")
            const text = yield* Effect.tryPromise({
              try: () => readFile(path, "utf8"),
              catch: (cause: unknown) => cause,
            }).pipe(
              Effect.catchAll((cause: unknown) =>
                isNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(storeError("read", `could not read ${path}`, cause)),
              ),
            )
            if (text === undefined) return undefined
            const formatOf = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })))(text).pipe(
              Effect.map((raw) => (typeof raw.formatVersion === "number" ? raw.formatVersion : 1)),
              Effect.orElseSucceed(() => 1),
            )
            if (formatOf >= FORMAT_VERSION) return yield* decodeRecord(text, path)
            // Format 1: project it once and persist, so one shape exists on disk from then on.
            const legacy = yield* Schema.decodeUnknown(Schema.parseJson(LegacyChangeRecord), {
              onExcessProperty: "preserve",
            })(text).pipe(
              Effect.mapError((error) => storeError("read", `malformed change record at ${path}`, error)),
            )
            const migrated = migrateRecord(legacy as typeof legacy & Record<string, unknown>)
            yield* writeAt(dir, migrated as StoredRecord)
            return yield* decodeRecord(JSON.stringify(migrated), path)
        })

      /** Every directory this change may live in: each pair's active root first — the active
       * copy wins — then each pair's archive. */
      const locate = (changeId: ChangeId): Effect.Effect<Located | undefined, ChangeStoreError> =>
        Effect.gen(function* () {
          const candidates = [
            ...options.roots.map(({ root }) => join(root, changeId)),
            ...options.roots.map(({ archiveRoot }) => join(archiveRoot, changeId)),
          ]
          for (const dir of candidates) {
            const record = yield* readAt(dir)
            if (record) return { record, dir }
          }
          return undefined
        })

      const asRepositoryError =
        (changeId: ChangeId, operation: "read" | "write") =>
        (error: ChangeStoreError): RepositoryStoreError =>
          new RepositoryStoreError({ changeId, operation, message: error.message, cause: error.cause })

      /** The links a record's specs describe: one per checkout, with the derived id and
       * directory name the specs stand for. */
      const linksOf = (record: StoredRecord): readonly Repository[] =>
        (record.checkouts ?? []).map((spec) => repositoryFromSpec(ChangeId.make(record.id), spec))

      const recordFor = (
        change: Change,
        repositories: readonly Repository[],
        raw: Partial<StoredRecord> = {},
      ): StoredRecord => ({
        ...raw,
        id: change.changeId,
        title: change.title,
        branch: change.branch,
        state: change.phase,
        createdAt: change.createdAt,
        ...(change.completedAt ? { completedAt: change.completedAt } : {}),
        checkouts: repositories.map(specFromRepository),
        formatVersion: FORMAT_VERSION,
        revision: (raw.revision ?? 0) + 1,
      })

      const changeOf = (record: StoredRecord, dir: string): Change =>
        new Change({
          changeId: ChangeId.make(record.id),
          title: record.title ?? record.id,
          workspaceLocation: dir,
          branch: record.branch ?? record.id,
          phase: record.state ?? "Implementation",
          createdAt: record.createdAt ?? "",
          ...(record.completedAt ? { completedAt: record.completedAt } : {}),
          revision: record.revision ?? 0,
        })

      const read = Effect.fn("ChangeStore.read")(function* (changeId: ChangeId) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const located = yield* locate(changeId)
            return located ? changeOf(located.record, located.dir) : undefined
          }),
        )
      })

      const list = Effect.fn("ChangeStore.list")(function* () {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const changes: Change[] = []
            const bases = options.roots.flatMap(({ root, archiveRoot }) => [root, archiveRoot])
            for (const base of bases) {
              const entries = yield* Effect.tryPromise({
                try: () => readdir(base, { withFileTypes: true }),
                catch: (cause: unknown) => cause,
              }).pipe(
                Effect.catchAll((cause: unknown) =>
                  isNotFound(cause) ? Effect.succeed([]) : Effect.fail(storeError("read", `could not list ${base}`, cause)),
                ),
              )
              for (const entry of entries) {
                if (!entry.isDirectory()) continue
                const dir = join(base, entry.name)
                const record = yield* readAt(dir)
                if (!record) continue
                changes.push(changeOf(record, dir))
              }
            }
            return changes
          }),
        )
      })

      const create = Effect.fn("ChangeStore.create")(function* (
        change: Change,
        repositories: readonly Repository[],
      ) {
        // The primary changes root: the application creates changes through its own store,
        // which routes by the change's workspace.
        yield* lock.withPermits(1)(writeAt(join(options.roots[0]!.root, change.changeId), recordFor(change, repositories)))
      })

      const patch = Effect.fn("ChangeStore.patch")(function* (
        changeId: ChangeId,
        patch: { readonly phase: ChangePhase; readonly completedAt?: string; readonly expectedRevision?: number },
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const located = yield* locate(changeId)
            if (!located)
              return yield* new ChangeNotFound({ changeId, message: `change ${changeId} was not found` })
            // Optimistic concurrency: a caller that read a revision writes only onto it. The
            // check is inside the store's lock, so two writers that read the same revision
            // cannot both win — the second is told the record moved rather than overwriting it.
            const actual = located.record.revision ?? 0
            if (patch.expectedRevision !== undefined && patch.expectedRevision !== actual) {
              return yield* new ChangeConflict({
                changeId,
                expected: patch.expectedRevision,
                actual,
                message: `change ${changeId} moved on: expected revision ${patch.expectedRevision}, found ${actual}`,
              })
            }
            yield* writable(located.record)
            const next = recordFor(
              new Change({
                changeId,
                title: located.record.title ?? changeId,
                workspaceLocation: located.dir,
                branch: located.record.branch ?? changeId,
                phase: patch.phase,
                createdAt: located.record.createdAt ?? "",
                ...(patch.completedAt
                  ? { completedAt: patch.completedAt }
                  : located.record.completedAt
                    ? { completedAt: located.record.completedAt }
                    : {}),
              }),
              linksOf(located.record),
              located.record,
            )
            yield* writeAt(located.dir, next)
            // A terminal phase moves the change into the archive of the pair it lives under —
            // its workspace's archive root. A change that predates a root override still
            // travels to the archive beside where it was made, and one already archived is
            // left where it is.
            const pair = options.roots.find(
              ({ root, archiveRoot }) =>
                located.dir === join(root, changeId) || located.dir === join(archiveRoot, changeId),
            )
            const active = pair !== undefined && located.dir === join(pair.root, changeId)
            if ((patch.phase === "Completed" || patch.phase === "Cancelled") && pair && active) {
              const archiveDir = join(pair.archiveRoot, changeId)
              yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(pair.archiveRoot, { recursive: true })
                  await rename(located.dir, archiveDir)
                },
                catch: (cause: unknown) => storeError("write", `could not archive ${changeId}`, cause),
              })
            }
            return new Change({
              changeId,
              title: next.title ?? changeId,
              workspaceLocation:
                patch.phase === "Completed" || patch.phase === "Cancelled"
                  ? join(pair?.archiveRoot ?? options.roots[0]!.archiveRoot, changeId)
                  : located.dir,
              branch: next.branch ?? changeId,
              phase: patch.phase,
              createdAt: next.createdAt ?? "",
              ...(next.completedAt ? { completedAt: next.completedAt } : {}),
              revision: next.revision ?? actual + 1,
            })
          }),
        )
      })

      const listRepositories = Effect.fn("ChangeStore.listRepositories")(function* (changeId: ChangeId) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const located = yield* locate(changeId).pipe(Effect.mapError(asRepositoryError(changeId, "read")))
            return located ? linksOf(located.record) : []
          }),
        )
      })

      const addRepository = Effect.fn("ChangeStore.addRepository")(function* (input: AddRepositoryInput) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const located = yield* locate(input.changeId).pipe(
              Effect.mapError(asRepositoryError(input.changeId, "read")),
            )
            if (!located)
              return yield* new RepositoryStoreError({
                changeId: input.changeId,
                operation: "write",
                message: "change not found",
              })
            yield* writable(located.record)
            const repository = repositoryFromSpec(input.changeId, specFromInput(input))
            yield* writeAt(
              located.dir,
              recordFor(changeOf(located.record, located.dir), [...linksOf(located.record), repository], located.record),
            ).pipe(Effect.mapError(asRepositoryError(input.changeId, "write")))
            return repository
          }),
        )
      })

      const removeRepository = Effect.fn("ChangeStore.removeRepository")(function* (
        changeId: ChangeId,
        repositoryId: RepositoryId,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const located = yield* locate(changeId).pipe(Effect.mapError(asRepositoryError(changeId, "read")))
            if (!located) return false
            yield* writable(located.record)
            const links = linksOf(located.record)
            const repositories = links.filter((repository) => repository.repositoryId !== repositoryId)
            if (repositories.length === links.length) return false
            yield* writeAt(located.dir, recordFor(changeOf(located.record, located.dir), repositories, located.record)).pipe(
              Effect.mapError(asRepositoryError(changeId, "write")),
            )
            return true
          }),
        )
      })

      return { read, list, create, patch, listRepositories, addRepository, removeRepository }
    }),
  )

/** The eager sweep: migrate every record under every scope's changes roots and archives once
 * at startup. Reading them through the store is the migration — a format-1 record is projected
 * and persisted on its next read — so this only has to touch each record. */
export const migrateStoredRecords = (options: {
  readonly roots: readonly RootPair[]
}): Effect.Effect<void, ChangeStoreError> =>
  Effect.gen(function* () {
    const bases = options.roots.flatMap(({ root, archiveRoot }) => [root, archiveRoot])
    for (const base of bases) {
      const entries = yield* Effect.tryPromise({
        try: () => readdir(base, { withFileTypes: true }),
        catch: (cause: unknown) => cause,
      }).pipe(
        Effect.catchAll((cause: unknown) =>
          isNotFound(cause)
            ? Effect.succeed([])
            : Effect.fail(storeError("read", `could not list ${base}`, cause)),
        ),
      )
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const path = join(base, entry.name, "change.json")
        const text = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (cause: unknown) => cause,
        }).pipe(
          Effect.catchAll((cause: unknown) =>
            isNotFound(cause)
              ? Effect.succeed(undefined)
              : Effect.fail(storeError("read", `could not read ${path}`, cause)),
          ),
        )
        if (text === undefined) continue
        const formatOf = yield* Schema.decodeUnknown(
          Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
        )(text).pipe(
          Effect.map((raw) => (typeof raw.formatVersion === "number" ? raw.formatVersion : 1)),
          Effect.orElseSucceed(() => 1),
        )
        if (formatOf >= FORMAT_VERSION) continue
        const legacy = yield* Schema.decodeUnknown(Schema.parseJson(LegacyChangeRecord), {
          onExcessProperty: "preserve",
        })(text).pipe(
          Effect.mapError((error) => storeError("read", `malformed change record at ${path}`, error)),
        )
        const migrated = migrateRecord(legacy as typeof legacy & Record<string, unknown>)
        const dir = join(base, entry.name)
        const temp = `${path}.tmp`
        yield* Effect.tryPromise({
          try: async () => {
            await writeFile(temp, JSON.stringify(migrated, null, 2) + "\n")
            await rename(temp, path)
          },
          catch: (cause: unknown) => storeError("write", `could not migrate ${path}`, cause),
        })
      }
    }
  })
