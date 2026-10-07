/** The power operations: the state read, arm and disarm decode and name their routes. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("power reads state, arms and disarms through their routes", async () => {
  const calls: { method: string; url: string; body: string | undefined }[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body === undefined ? undefined : String(init.body),
      })
      return url.endsWith("/api/power")
        ? Response.json({ phase: "disarmed", agents: [] })
        : Response.json({ results: [{ source: "", status: "armed" }] })
    },
  })

  expect(await client.power.state()).toEqual({ phase: "disarmed", agents: [] })
  expect(await client.power.arm([""])).toEqual({ results: [{ source: "", status: "armed" }] })
  expect(await client.power.disarm([""])).toEqual({ results: [{ source: "", status: "armed" }] })

  expect(calls.map((call) => call.url)).toEqual([
    "http://x/api/power",
    "http://x/api/power/arm",
    "http://x/api/power/disarm",
  ])
  expect(JSON.parse(calls[1]!.body!)).toEqual({ targets: [""] })
  expect(JSON.parse(calls[2]!.body!)).toEqual({ targets: [""] })
})
