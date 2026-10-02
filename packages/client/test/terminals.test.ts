/** The terminals operations: the window list and the terminal page's URL decode as the server
 * encodes them. */
import { expect, test } from "bun:test"

import { ChangeId } from "@corvi/contracts/changes"
import { makeCorviClient } from "../src/index.ts"

test("terminals and the terminal URL decode", async () => {
  const calls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      const url = String(input)
      calls.push(url)
      return url.endsWith("/api/terminals")
        ? Response.json({
            a: [
              {
                index: 0,
                id: "@1",
                label: "l",
                detail: "d",
                attention: false,
                active: true,
                activity: false,
                panes: ["@1"],
                activePane: "@1",
              },
            ],
          })
        : Response.json({ url: "/term/a" })
    },
  })

  expect((await client.terminals.list()).a?.[0]?.attention).toBe(false)
  expect((await client.terminals.url(ChangeId.make("a"))).url).toBe("/term/a")
  expect(calls.some((url) => url.endsWith("/changes/a/terminal"))).toBe(true)
})
