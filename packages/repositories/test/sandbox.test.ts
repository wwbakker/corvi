import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Effect } from "effect"

import { Fixture, runScoped, sandboxLayer } from "./sandbox.ts"

test("the sandbox is released when its effect is interrupted by the deadline", async () => {
  let acquired = ""
  const interrupted = runScoped(
    Effect.gen(function* () {
      const fixture = yield* Fixture
      acquired = fixture.tmp
      return yield* Effect.never
    }),
    sandboxLayer,
    20,
  )
  await expect(interrupted).rejects.toThrow()
  expect(acquired).not.toBe("")
  expect(existsSync(acquired)).toBe(false)
})
