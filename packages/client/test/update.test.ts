/** The update operations: each names its route and decodes the status the server answers. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("the update operations name their routes and decode the status", async () => {
  const calls: { url: string; method: string }[] = []
  const status = {
    eligible: true,
    behind: 2,
    commits: [
      { sha: "abc1234", subject: "second", url: "https://github.com/acme/app/commit/abc1234" },
    ],
    compareUrl: "https://github.com/acme/app/compare/x...y",
    progress: null,
    restartPending: false,
  }
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" })
      return Response.json(status)
    },
  })
  expect((await client.update.status()).behind).toBe(2)
  expect((await client.update.check()).commits[0]?.url).toContain("/commit/abc1234")
  expect((await client.update.start()).restartPending).toBe(false)
  expect(calls).toEqual([
    { url: "http://127.0.0.1:4000/api/app/update", method: "GET" },
    { url: "http://127.0.0.1:4000/api/app/update/check", method: "POST" },
    { url: "http://127.0.0.1:4000/api/app/update", method: "POST" },
  ])
})
