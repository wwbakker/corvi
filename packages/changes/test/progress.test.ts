import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"

import { ChangeId } from "@corvi/contracts/changes"
import { OperationProgress } from "../src/progress.ts"
import { progressLayer } from "../src/node/index.ts"

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), `corvi-${process.env.CORVI_TEST_RUN ?? "local"}-progress-`))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const run = <A, E>(program: Effect.Effect<A, E, OperationProgress>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(program.pipe(Effect.either, Effect.provide(progressLayer({ roots: [{ root, archiveRoot: `${root}-archive` }] }))))

test("the operation journal appends steps and survives a reload", async () => {
  const result = await run(
    Effect.gen(function* () {
      const progress = yield* OperationProgress
      yield* progress.record({
        changeId: ChangeId.make("demo"),
        step: { id: "one", label: "checkout one", state: "running" },
      })
      yield* progress.record({
        changeId: ChangeId.make("demo"),
        step: { id: "one", label: "checkout one", state: "done" },
      })
      return yield* Effect.tryPromise(() => Bun.file(join(root, "demo", "operations.json")).json())
    }),
  )
  expect(Either.isRight(result)).toBe(true)
  if (Either.isRight(result)) {
    expect(result.right).toEqual([
      { id: "one", label: "checkout one", state: "running" },
      { id: "one", label: "checkout one", state: "done" },
    ])
  }
})

test("a malformed journal is a typed error", async () => {
  await Bun.write(join(root, "broken", "operations.json"), "{ nope }\n")
  const result = await run(
    Effect.gen(function* () {
      const progress = yield* OperationProgress
      return yield* progress.record({
        changeId: ChangeId.make("broken"),
        step: { id: "x", label: "x", state: "running" },
      })
    }),
  )
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) expect(result.left._tag).toBe("ChangeStoreError")
})
