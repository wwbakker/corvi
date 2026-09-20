/** File-backed change store: one JSON envelope per change at `<root>/<changeId>/change.json`.
 *
 * Writes replace the file atomically (temp file plus rename) and are serialized in-process, so
 * a read-modify-write cannot lose an update within one server. Cross-process locking is not
 * provided yet; that is why `ChangeConflict` exists but is not raised here.
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
import {
  ChangeNotFound,
  ChangeStoreError,
  RepositoryStoreError,
} from "../errors.ts"
import { ChangeStore } from "../store.ts"

const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  change: Change,
  repositories: Schema.Array(Repository),
})
type Envelope = typeof Envelope.Type

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT"

const storeError = (
  operation: "read" | "write",
  message: string,
  cause: unknown,
  changeId?: ChangeId,
): ChangeStoreError => new ChangeStoreError({ operation, message, cause, changeId })

const decodeEnvelope = (text: string, path: string): Effect.Effect<Envelope, ChangeStoreError> =>
  Schema.decodeUnknown(Schema.parseJson(Envelope))(text).pipe(
    Effect.mapError((error) => {
      const detail = ParseResult.ArrayFormatter.formatIssueSync(error.issue)
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ")
      return storeError("read", `malformed change record at ${path}: ${detail}`, error)
    }),
  )

export const layer = (options: { readonly root: string }): Layer.Layer<ChangeStore> =>
  Layer.effect(
    ChangeStore,
    Effect.gen(function* () {
      const lock = yield* Effect.makeSemaphore(1)

      const dirFor = (changeId: ChangeId): string => join(options.root, changeId)
      const fileFor = (changeId: ChangeId): string => join(dirFor(changeId), "change.json")

      const readEnvelope = (changeId: ChangeId): Effect.Effect<Envelope | undefined, ChangeStoreError> =>
        Effect.gen(function* () {
          const path = fileFor(changeId)
          const text = yield* Effect.tryPromise({
            try: () => readFile(path, "utf8"),
            catch: (cause: unknown) => cause,
          }).pipe(
            Effect.catchAll((cause: unknown) =>
              isNotFound(cause)
                ? Effect.succeed(undefined)
                : Effect.fail(storeError("read", `could not read ${path}`, cause, changeId)),
            ),
          )
          if (text === undefined) return undefined
          return yield* decodeEnvelope(text, path)
        })

      const writeEnvelope = (changeId: ChangeId, envelope: Envelope): Effect.Effect<void, ChangeStoreError> => {
        const dir = dirFor(changeId)
        const path = fileFor(changeId)
        const temp = `${path}.tmp`
        const attempt = <A>(what: string, work: () => Promise<A>): Effect.Effect<A, ChangeStoreError> =>
          Effect.tryPromise({
            try: work,
            catch: (cause: unknown) => storeError("write", `${what} for ${changeId}`, cause, changeId),
          })
        return Effect.gen(function* () {
          yield* attempt("could not create the change directory", () => mkdir(dir, { recursive: true }))
          yield* attempt("could not write the change record", () =>
            writeFile(temp, JSON.stringify(envelope, null, 2) + "\n"),
          )
          yield* attempt("could not replace the change record", () => rename(temp, path))
        })
      }

      const asRepositoryError =
        (changeId: ChangeId, operation: "read" | "write") =>
        (error: ChangeStoreError): RepositoryStoreError =>
          new RepositoryStoreError({ changeId, operation, message: error.message, cause: error.cause })

      const read = Effect.fn("ChangeStore.read")(function* (changeId: ChangeId) {
        const envelope = yield* readEnvelope(changeId)
        return envelope?.change
      })

      const list = Effect.fn("ChangeStore.list")(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(options.root, { withFileTypes: true }),
          catch: (cause: unknown) => storeError("read", `could not list ${options.root}`, cause),
        }).pipe(
          Effect.catchAll((error) =>
            isNotFound(error.cause) ? Effect.succeed([]) : Effect.fail(error),
          ),
        )
        const groups = yield* Effect.forEach(
          entries.filter((entry) => entry.isDirectory()),
          (entry) =>
            readEnvelope(ChangeId.make(entry.name)).pipe(
              Effect.map((envelope) => (envelope ? [envelope.change] : [])),
            ),
          { concurrency: 8 },
        )
        return groups.flat()
      })

      const create = Effect.fn("ChangeStore.create")(function* (
        change: Change,
        repositories: readonly Repository[],
      ) {
        yield* lock.withPermits(1)(
          writeEnvelope(change.changeId, {
            version: 1,
            revision: 1,
            change,
            repositories: [...repositories],
          }),
        )
      })

      const patch = Effect.fn("ChangeStore.patch")(function* (
        changeId: ChangeId,
        patch: { readonly phase: ChangePhase; readonly completedAt?: string },
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const envelope = yield* readEnvelope(changeId)
            if (!envelope) return yield* new ChangeNotFound({ changeId })
            const change = new Change({ ...envelope.change, ...patch })
            yield* writeEnvelope(changeId, {
              version: 1,
              revision: envelope.revision + 1,
              change,
              repositories: envelope.repositories,
            })
            return change
          }),
        )
      })

      const listRepositories = Effect.fn("ChangeStore.listRepositories")(function* (changeId: ChangeId) {
        const envelope = yield* readEnvelope(changeId).pipe(
          Effect.mapError(asRepositoryError(changeId, "read")),
        )
        return envelope?.repositories ?? []
      })

      const addRepository = Effect.fn("ChangeStore.addRepository")(function* (input: AddRepositoryInput) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const envelope = yield* readEnvelope(input.changeId).pipe(
              Effect.mapError(asRepositoryError(input.changeId, "read")),
            )
            if (!envelope)
              return yield* new RepositoryStoreError({
                changeId: input.changeId,
                operation: "write",
                message: "change not found",
              })
            const repository = new Repository({ ...input, repositoryId: RepositoryId.make(randomUUID()) })
            yield* writeEnvelope(input.changeId, {
              version: 1,
              revision: envelope.revision + 1,
              change: envelope.change,
              repositories: [...envelope.repositories, repository],
            }).pipe(Effect.mapError(asRepositoryError(input.changeId, "write")))
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
            const envelope = yield* readEnvelope(changeId).pipe(
              Effect.mapError(asRepositoryError(changeId, "read")),
            )
            if (!envelope) return false
            const repositories = envelope.repositories.filter((repository) => repository.repositoryId !== repositoryId)
            if (repositories.length === envelope.repositories.length) return false
            yield* writeEnvelope(changeId, {
              version: 1,
              revision: envelope.revision + 1,
              change: envelope.change,
              repositories,
            }).pipe(Effect.mapError(asRepositoryError(changeId, "write")))
            return true
          }),
        )
      })

      return { read, list, create, patch, listRepositories, addRepository, removeRepository }
    }),
  )
