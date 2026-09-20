/** File-backed operation journal: `<root>/<changeId>/operations.json`, appended step by step.
 * A failed step is recorded before the operation moves on, so a reload can read what happened. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"

import type { ChangeId } from "@corvi/contracts/changes"
import { ChangeStoreError } from "../errors.ts"
import { OperationProgress, type OperationStep } from "../progress.ts"

const Steps = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    state: Schema.Literal("running", "done", "failed"),
    detail: Schema.optional(Schema.String),
  }),
)

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT"

export const layer = (options: { readonly root: string }): Layer.Layer<OperationProgress> =>
  Layer.effect(
    OperationProgress,
    Effect.gen(function* () {
      const lock = yield* Effect.makeSemaphore(1)
      const fileFor = (changeId: ChangeId): string => join(options.root, changeId, "operations.json")

      const record = Effect.fn("OperationProgress.record")(function* (input: {
        readonly changeId: ChangeId
        readonly step: OperationStep
      }) {
        const path = fileFor(input.changeId)
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
                await mkdir(join(options.root, input.changeId), { recursive: true })
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
