/** Read-only services over the legacy change records: `<root>/<id>/change.json` and the archive.
 *
 * The record layout is the old app's; this module owns its codec so the legacy shape never leaks
 * into the new model. Writes fail explicitly with a typed error — a read-only adapter must not
 * pretend to implement them.
 */
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"

import type { AddRepositoryInput, Change, ChangeFilter, ChangeId, ChangePhase, Repository } from "@corvi/contracts/changes"
import { ChangeRepositories } from "../change-repositories.ts"
import { ChangeService } from "../changes.ts"
import { ChangeNotFound, ChangeStoreError, RepositoryStoreError } from "../errors.ts"
import {
  LegacyChangeRecord,
  projectLegacyChange,
  projectLegacyRepositories,
} from "../legacy.ts"
import { isFinished } from "../rules.ts"

export interface LegacyReadOptions {
  readonly root: string
  readonly archiveRoot: string
}

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT"

const decodeRecord = (text: string, path: string): Effect.Effect<LegacyChangeRecord, ChangeStoreError> =>
  Schema.decodeUnknown(Schema.parseJson(LegacyChangeRecord))(text).pipe(
    Effect.mapError(
      (cause) =>
        new ChangeStoreError({
          operation: "read",
          message: `malformed legacy change record at ${path}`,
          cause,
        }),
    ),
  )

const readRecord = (path: string): Effect.Effect<LegacyChangeRecord | undefined, ChangeStoreError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause: unknown) => cause,
    }).pipe(
      Effect.catchAll((cause: unknown) =>
        isNotFound(cause)
          ? Effect.succeed(undefined)
          : Effect.fail(
              new ChangeStoreError({ operation: "read", message: `could not read ${path}`, cause }),
            ),
      ),
    )
    if (text === undefined) return undefined
    return yield* decodeRecord(text, path)
  })

export const readLayer = (options: LegacyReadOptions): Layer.Layer<ChangeService | ChangeRepositories> => {
  const roots = [options.root, options.archiveRoot]

  const locate = (changeId: ChangeId): Effect.Effect<string | undefined, ChangeStoreError> =>
    Effect.gen(function* () {
      for (const root of roots) {
        const dir = join(root, changeId)
        const record = yield* readRecord(join(dir, "change.json"))
        if (record) return dir
      }
      return undefined
    })

  const listRecorded = (): Effect.Effect<readonly { readonly record: LegacyChangeRecord; readonly dir: string }[], ChangeStoreError> =>
    Effect.gen(function* () {
      const located: { record: LegacyChangeRecord; dir: string }[] = []
      for (const root of roots) {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(root, { withFileTypes: true }),
          catch: (cause: unknown) => cause,
        }).pipe(
          Effect.catchAll((cause: unknown) =>
            isNotFound(cause)
              ? Effect.succeed([])
              : Effect.fail(new ChangeStoreError({ operation: "read", message: `could not list ${root}`, cause })),
          ),
        )
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const dir = join(root, entry.name)
          const record = yield* readRecord(join(dir, "change.json"))
          if (record) located.push({ record, dir })
        }
      }
      return located
    })

  const changeService = Layer.succeed(ChangeService, {
    getChange: (changeId) =>
      locate(changeId).pipe(
        Effect.flatMap((dir) => {
          if (!dir) return Effect.fail(new ChangeNotFound({ changeId }))
          return readRecord(join(dir, "change.json")).pipe(
            Effect.flatMap((record) =>
              record ? Effect.succeed(projectLegacyChange(record, dir)) : Effect.fail(new ChangeNotFound({ changeId })),
            ),
          )
        }),
      ),
    listChanges: (filter: ChangeFilter) =>
      listRecorded().pipe(
        Effect.map((records) =>
          records
            .map(({ record, dir }) => projectLegacyChange(record, dir))
            .filter((change) => (filter === "Archived" ? isFinished(change) : !isFinished(change))),
        ),
      ),
    createChange: () =>
      Effect.fail(
        new ChangeStoreError({ operation: "write", message: "legacy change records are read-only" }),
      ),
    transitionTo: () =>
      Effect.fail(
        new ChangeStoreError({ operation: "write", message: "legacy change records are read-only" }),
      ),
  })

  const changeRepositories = Layer.succeed(ChangeRepositories, {
    listRepositories: (changeId) =>
      locate(changeId).pipe(
        Effect.flatMap((dir) =>
          dir
            ? readRecord(join(dir, "change.json")).pipe(
                Effect.map((record) => (record ? projectLegacyRepositories(record) : [])),
              )
            : Effect.succeed([] as readonly Repository[]),
        ),
        Effect.mapError(
          (error) =>
            new RepositoryStoreError({
              changeId,
              operation: "read",
              message: error.message,
              cause: error.cause,
            }),
        ),
      ),
    addRepository: (input: AddRepositoryInput) =>
      Effect.fail(
        new RepositoryStoreError({
          changeId: input.changeId,
          operation: "write",
          message: "legacy change records are read-only",
        }),
      ),
    removeRepository: ({ changeId }: { readonly changeId: ChangeId }) =>
      Effect.fail(
        new RepositoryStoreError({
          changeId,
          operation: "write",
          message: "legacy change records are read-only",
        }),
      ),
  })

  return Layer.merge(changeService, changeRepositories)
}
