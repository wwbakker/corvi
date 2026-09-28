/** The workspaces operations: the workspace list and the extension pages decode as the server
 * encodes them. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("the workspaces and their pages decode", async () => {
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) =>
      String(input).endsWith("/api/workspaces")
        ? Response.json({ workspaces: [{ id: "demo", name: "Demo" }], platform: "linux" })
        : Response.json({
            pages: [{ id: "leftovers", title: "Leftovers", extension: "leftovers" }],
          }),
  })

  expect((await client.workspaces.list()).platform).toBe("linux")
  expect((await client.workspaces.list()).workspaces[0]?.id).toBe("demo")
  expect((await client.workspaces.pages("w"))[0]?.id).toBe("leftovers")
})
