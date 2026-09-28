/** The server's identity: the discovery probe decodes as the server encodes it. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("identity names its route and decodes the change ids", async () => {
  const urls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://127.0.0.1:4000/",
    fetch: async (input) => {
      urls.push(String(input))
      return Response.json({ changeIds: ["demo", "other"] })
    },
  })

  expect((await client.server.identity()).changeIds).toEqual(["demo", "other"])
  expect(urls).toEqual(["http://127.0.0.1:4000/api/identity"])
})
