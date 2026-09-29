import { test, expect } from "bun:test";

import { applyGuide, guideText, GUIDE_SECTION } from "../src/cli-guide.ts";

/**
 * The CLI guide's gated half: the pointer joins pi's system prompt inside a Corvi pane and
 * nothing at all changes outside one. The text itself is the other test's subject
 * (`test/cliGuide.test.ts` pins it equal to opencode's).
 */
test("inside Corvi the guide joins the system prompt, outside nothing is set", () => {
  const sections: Record<string, string | undefined> = {};
  applyGuide({ systemPromptOptions: { sections } }, { CORVI_CHANGE_ID: "PROJ-1" });
  expect(sections[GUIDE_SECTION]).toBe(guideText("PROJ-1"));
  expect(sections[GUIDE_SECTION]).toContain("corvi subagent");

  const outside: Record<string, string | undefined> = {};
  applyGuide({ systemPromptOptions: { sections: outside } }, {});
  expect(outside[GUIDE_SECTION]).toBeUndefined();
});

test("the gate is the pane's, and a stale section is deleted rather than left behind", () => {
  const sections: Record<string, string | undefined> = {};
  applyGuide({ systemPromptOptions: { sections } }, { CORVI_CHANGE_ID: "PROJ-1" });
  // The same event object reused without the pane's context (a session moved, an env lost).
  applyGuide({ systemPromptOptions: { sections } }, { CORVI_CHANGE_ID: "" });
  expect(sections[GUIDE_SECTION]).toBeUndefined();
});
