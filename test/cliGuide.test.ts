import { test, expect } from "bun:test";

import { guideText as piGuide } from "../integrations/pi/src/cli-guide.ts";
import { guideText as opencodeGuide } from "../integrations/opencode/src/cli-guide.ts";

/**
 * The CLI guide text is stated twice on purpose — each extension is loaded by its own agent
 * outside Corvi's module graph and the two deliberately share no code (each package's AGENTS.md)
 * — so this test is what keeps the two statements one statement.
 */
test("the pi and opencode guides say the same thing", () => {
  expect(opencodeGuide("PROJ-1")).toBe(piGuide("PROJ-1"));
  expect(piGuide("PROJ-1")).toContain("PROJ-1");
});
