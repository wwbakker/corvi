/** The repository browser: directory listings and branches decode as the server encodes them. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("directories and branches decode", async () => {
  const calls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      return url.includes("/api/repos/branches")
        ? Response.json({ branches: ["main", "dev"], default: "main" })
        : Response.json({
            path: "/repos",
            entries: [{ path: "/repos/x", name: "x", isRepo: true }],
          })
    },
  })

  expect((await client.repositories.branches("/repos/x")).default).toBe("main")
  expect((await client.repositories.directories({ path: "/repos", hidden: true })).entries[0]
    ?.isRepo).toBe(true)
  expect(calls.some((url) => url.endsWith("/api/repos?path=%2Frepos&hidden=1"))).toBe(true)
})
