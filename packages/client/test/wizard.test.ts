/** The wizard's spec: the steps and the plan template decode as the server encodes them. */
import { expect, test } from "bun:test"

import { makeCorviClient } from "../src/index.ts"

test("the wizard's spec decodes its steps and plan template", async () => {
  const calls: string[] = []
  const client = makeCorviClient({
    baseUrl: "http://x",
    fetch: async (input) => {
      calls.push(String(input))
      return Response.json({
        steps: [{ id: "jira", extension: "jira", title: "Jira", phase: "issue" }],
        planTemplate: "# Template",
      })
    },
  })

  const wizard = await client.wizard.spec("w")
  expect(wizard.steps[0]?.phase).toBe("issue")
  expect(wizard.planTemplate).toBe("# Template")
  expect(calls.some((url) => url.endsWith("/api/wizard?workspace=w"))).toBe(true)
})
