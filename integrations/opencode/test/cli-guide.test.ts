import { test, expect } from "bun:test";

import { applyGuide, guideText } from "../src/cli-guide.ts";

/**
 * The CLI guide's gated half: the pointer joins the system prompt inside a Corvi pane, once,
 * and nothing at all changes outside one. The text itself is the other test's subject
 * (`test/cliGuide.test.ts` pins it equal to pi's).
 */
test("inside Corvi the guide joins the system prompt exactly once", () => {
  const system: string[] = [];
  applyGuide(system, { CORVI_CHANGE_ID: "PROJ-1" });
  applyGuide(system, { CORVI_CHANGE_ID: "PROJ-1" });
  expect(system).toEqual([guideText("PROJ-1")]);
  expect(system[0]).toContain("corvi subagent");
});

test("outside Corvi nothing is said", () => {
  const system: string[] = [];
  applyGuide(system, {});
  applyGuide(system, { CORVI_CHANGE_ID: "" });
  expect(system).toEqual([]);
});
