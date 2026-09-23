/** File-backed operation journal: `<change dir>/operations.json`, appended step by step.
 * A failed step is recorded before the operation moves on, so a reload can read what happened.
 * The journal lives beside the record it fences on, so it follows the change through every
 * scope's roots. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"

import type { ChangeId } from "@corvi/contracts/changes"
import { ChangeFormatTooNew, ChangeStoreError } from "../errors.ts"
import { FORMAT_VERSION } from "../record.ts"
import { OperationProgress, type OperationStep } from "../progress.ts"
import type { RootPair } from "./store.ts"

const Steps = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    state: Schema.Literal("waiting", "running", "done", "failed"),
    detail: Schema.optional(Schema.String),
  }),
)

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT"

export const layer = (options: { readonly roots: readonly RootPair[] }): Layer.Layer<OperationProgress> =>
  Layer.effect(
    OperationProgress,
    Effect.gen(function* () {
      const lock = yield* Effect.makeSemaphore(1)
      /** Every directory this change may live in: each pair's active root first, then each
       * pair's archive. The journal goes beside the record it fences on. */
      const dirsFor = (changeId: ChangeId): string[] => [
        ...options.roots.map(({ root }) => join(root, changeId)),
        ...options.roots.map(({ archiveRoot }) => join(archiveRoot, changeId)),
      ]
      const dirOf = (changeId: ChangeId): Effect.Effect<string> =>
        Effect.gen(function* () {
          for (const dir of dirsFor(changeId)) {
            const found = yield* Effect.tryPromise({
              try: () => readFile(join(dir, "change.json"), "utf8"),
              catch: (cause: unknown) => cause,
            }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
            if (found !== undefined) return dir
          }
          // Not written yet: the journal starts the directory the change will be created in.
          return join(options.roots[0]!.root, changeId)
        })
      const record = Effect.fn("OperationProgress.record")(function* (input: {
        readonly changeId: ChangeId
        readonly step: OperationStep
      }) {
        const dir = yield* dirOf(input.changeId)
        const path = join(dir, "operations.json")
        // The downgrade fence reaches the journal too: a change this version cannot write is
        // left exactly as a newer Corvi left it, journal included.
        const recordText = yield* Effect.tryPromise({
          try: () => readFile(join(dir, "change.json"), "utf8"),
          catch: (cause: unknown) => cause,
        }).pipe(
          Effect.catchAll((cause: unknown) =>
            isNotFound(cause)
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new ChangeStoreError({
                    changeId: input.changeId,
                    operation: "read",
                    message: `could not read the change record for ${input.changeId}`,
                    cause,
                  }),
                ),
          ),
        )
        const recordFormat =
          recordText === undefined
            ? FORMAT_VERSION
            : yield* Schema.decodeUnknown(
                Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
              )(recordText).pipe(
                Effect.map((raw) => (typeof raw.formatVersion === "number" ? raw.formatVersion : 1)),
                Effect.orElseSucceed(() => 1),
              )
        if (recordFormat > FORMAT_VERSION)
          return yield* new ChangeFormatTooNew({
            changeId: input.changeId,
            recordFormat,
            appFormat: FORMAT_VERSION,
            message:
              `change ${input.changeId} was written by a newer version of Corvi ` +
              `(record format ${recordFormat}, this one writes ${FORMAT_VERSION}); upgrade to edit it`,
          })
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* Effect.tryPromise({
              try: () => readFile(path, "utf8"),
              catch: (cause: unknown) => cause,
            }).pipe(
              Effect.catchAll((cause: unknown) =>
                isNotFound(cause)
                  ? Effect.succeed("[]")
                  : Effect.fail(
                      new ChangeStoreError({
                        changeId: input.changeId,
                        operation: "read",
                        message: `could not read ${path}`,
                        cause,
                      }),
                    ),
              ),
            )
            const steps = yield* Schema.decodeUnknown(Schema.parseJson(Steps))(existing).pipe(
              Effect.mapError(
                (error) =>
                  new ChangeStoreError({
                    changeId: input.changeId,
                    operation: "read",
                    message: `malformed operation journal at ${path}`,
                    cause: error,
                  }),
              ),
            )
            const temp = `${path}.tmp`
            const next = [...steps, input.step]
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dir, { recursive: true })
                await writeFile(temp, JSON.stringify(next, null, 2) + "\n")
                await rename(temp, path)
              },
              catch: (cause) =>
                new ChangeStoreError({
                  changeId: input.changeId,
                  operation: "write",
                  message: `could not record the operation journal at ${path}`,
                  cause,
                }),
            })
          }),
        )
      })

      return { record }
    }),
  )
