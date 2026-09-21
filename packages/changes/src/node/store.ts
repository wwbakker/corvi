/** File-backed change store, legacy-compatible in place.
 *
 * The record stays `<root>/<changeId>/change.json` and keeps every field the old app writes:
 * `state`, `repos`, `direct`, and unknown keys are preserved verbatim. The new link model is
 * materialized into a `repositories` array on that same record, and `repos`/`direct` are kept in
 * sync from it, so both views have one source of truth. A phase transition to a terminal phase
 * moves the directory into the archive root.
 *
 * Writes replace the file atomically (temp file plus rename) and are serialized in-process.
 * Cross-process locking is not provided yet; that is why `ChangeConflict` exists but is not
 * raised here.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, ParseResult, Schema } from "effect"

import {
  Change,
  ChangeId,
  Repository,
  RepositoryId,
  type AddRepositoryInput,
  type ChangePhase,
} from "@corvi/contracts/changes"
import { ChangeConflict, ChangeNotFound, ChangeStoreError, RepositoryStoreError } from "../errors.ts"
import {
  LegacyChangeRecordFields,
  legacyStateForPhase,
  mapLegacyPhase,
  projectLegacyRepositories,
} from "../legacy.ts"
import { ChangeStore } from "../store.ts"

const StoredRecord = Schema.Struct({
  ...LegacyChangeRecordFields,
  /** The new link model; absent on records the old app wrote before the migration. */
  repositories: Schema.optional(Schema.Array(Repository)),
  revision: Schema.optional(Schema.Number),
})
type StoredRecord = typeof StoredRecord.Type

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

export const layer = (options: { readonly root: string; readonly archiveRoot: string }): Layer.Layer<ChangeStore> =>
  Layer.effect(
    ChangeStore,
    Effect.gen(function* () {
      const lock = yield* Effect.makeSemaphore(1)

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
          return yield* decodeRecord(text, path)
        })

      /** Active first, then archived; the active copy wins. */
      const locate = (changeId: ChangeId): Effect.Effect<Located | undefined, ChangeStoreError> =>
        Effect.gen(function* () {
          for (const base of [options.root, options.archiveRoot]) {
            const dir = join(base, changeId)
            const record = yield* readAt(dir)
            if (record) return { record, dir }
          }
          return undefined
        })

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

      const asRepositoryError =
        (changeId: ChangeId, operation: "read" | "write") =>
        (error: ChangeStoreError): RepositoryStoreError =>
          new RepositoryStoreError({ changeId, operation, message: error.message, cause: error.cause })

      const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
        left.length === right.length && left.every((value) => right.includes(value))

      /** The materialized list wins only while it agrees with the legacy fields; the old app can
       * edit `repos`/`direct` without touching `repositories`, and that edit is authoritative. */
      const linksOf = (record: StoredRecord): readonly Repository[] => {
        const materialized = record.repositories ?? []
        const materializedDirect = materialized
          .filter((repository) => repository.checkoutMethod !== "UseNewLocationNewBranch")
          .map((repository) => repository.originalLocation)
        const agrees =
          sameSet(
            record.repos ?? [],
            materialized.map((repository) => repository.originalLocation),
          ) && sameSet(record.direct ?? [], materializedDirect)
        return materialized.length > 0 && agrees ? materialized : projectLegacyRepositories(record)
      }

      const recordFor = (
        change: Change,
        repositories: readonly Repository[],
        raw: Partial<StoredRecord> = {},
      ): StoredRecord => ({
        ...raw,
        id: change.changeId,
        title: change.title,
        branch: change.branch,
        state: legacyStateForPhase(change.phase),
        createdAt: change.createdAt,
        ...(change.completedAt ? { completedAt: change.completedAt } : {}),
        repositories: [...repositories],
        repos: repositories.map((repository) => repository.originalLocation),
        direct: repositories
          .filter((repository) => repository.checkoutMethod !== "UseNewLocationNewBranch")
          .map((repository) => repository.originalLocation),
        revision: (raw.revision ?? 0) + 1,
      })

      const read = Effect.fn("ChangeStore.read")(function* (changeId: ChangeId) {
        const located = yield* locate(changeId)
        if (!located) return undefined
        const change = new Change({
          changeId,
          title: located.record.title ?? changeId,
          workspaceLocation: located.dir,
          branch: located.record.branch ?? changeId,
          phase: mapLegacyPhase(located.record.state),
          createdAt: located.record.createdAt ?? "",
          ...(located.record.completedAt ? { completedAt: located.record.completedAt } : {}),
          revision: located.record.revision ?? 0,
        })
        return change
      })

      const list = Effect.fn("ChangeStore.list")(function* () {
        const changes: Change[] = []
        for (const base of [options.root, options.archiveRoot]) {
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
            changes.push(
              new Change({
                changeId: ChangeId.make(record.id),
                title: record.title ?? record.id,
                workspaceLocation: dir,
                branch: record.branch ?? record.id,
                phase: mapLegacyPhase(record.state),
                createdAt: record.createdAt ?? "",
                ...(record.completedAt ? { completedAt: record.completedAt } : {}),
                revision: record.revision ?? 0,
              }),
            )
          }
        }
        return changes
      })

      const create = Effect.fn("ChangeStore.create")(function* (
        change: Change,
        repositories: readonly Repository[],
      ) {
        yield* lock.withPermits(1)(writeAt(join(options.root, change.changeId), recordFor(change, repositories)))
      })

      const patch = Effect.fn("ChangeStore.patch")(function* (
        changeId: ChangeId,
        patch: { readonly phase: ChangePhase; readonly completedAt?: string; readonly expectedRevision?: number },
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const located = yield* locate(changeId)
            if (!located) return yield* new ChangeNotFound({ changeId })
            // Optimistic concurrency: a caller that read a revision writes only onto it. The
            // check is inside the store's lock, so two writers that read the same revision
            // cannot both win — the second is told the record moved rather than overwriting it.
            const actual = located.record.revision ?? 0
            if (patch.expectedRevision !== undefined && patch.expectedRevision !== actual) {
              return yield* new ChangeConflict({ changeId, expected: patch.expectedRevision, actual })
            }
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
            if (
              (patch.phase === "Completed" || patch.phase === "Cancelled") &&
              located.dir.startsWith(options.root)
            ) {
              const archiveDir = join(options.archiveRoot, changeId)
              yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(options.archiveRoot, { recursive: true })
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
                  ? join(options.archiveRoot, changeId)
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
        const located = yield* locate(changeId).pipe(Effect.mapError(asRepositoryError(changeId, "read")))
        return located ? linksOf(located.record) : []
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
            const repository = new Repository({ ...input, repositoryId: RepositoryId.make(randomUUID()) })
            const change = new Change({
              changeId: input.changeId,
              title: located.record.title ?? input.changeId,
              workspaceLocation: located.dir,
              branch: located.record.branch ?? input.changeId,
              phase: mapLegacyPhase(located.record.state),
              createdAt: located.record.createdAt ?? "",
              ...(located.record.completedAt ? { completedAt: located.record.completedAt } : {}),
            })
            yield* writeAt(
              located.dir,
              recordFor(change, [...linksOf(located.record), repository], located.record),
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
            const links = linksOf(located.record)
            const repositories = links.filter((repository) => repository.repositoryId !== repositoryId)
            if (repositories.length === links.length) return false
            const change = new Change({
              changeId,
              title: located.record.title ?? changeId,
              workspaceLocation: located.dir,
              branch: located.record.branch ?? changeId,
              phase: mapLegacyPhase(located.record.state),
              createdAt: located.record.createdAt ?? "",
              ...(located.record.completedAt ? { completedAt: located.record.completedAt } : {}),
            })
            yield* writeAt(located.dir, recordFor(change, repositories, located.record)).pipe(
              Effect.mapError(asRepositoryError(changeId, "write")),
            )
            return true
          }),
        )
      })

      return { read, list, create, patch, listRepositories, addRepository, removeRepository }
    }),
  )
