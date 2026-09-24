import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Either } from "effect";

import { builtinActionBody, builtinActionsDir } from "../src/node/index.ts";
import { parseActionFile } from "../src/model.ts";
import { renderActionBody } from "../src/render.ts";

test("every shipped action is a valid action file", () => {
  const names = readdirSync(builtinActionsDir())
    .filter((n) => n.endsWith(".md"))
    .sort();
  expect(names).toEqual(["brief.md", "new-pi.md", "review.md"]);
  for (const name of names) {
    const parsed = parseActionFile(readFileSync(join(builtinActionsDir(), name), "utf8"));
    expect(Either.isRight(parsed)).toBe(true);
  }
});

test("the brief is the built-in its file says it is", () => {
  const parsed = parseActionFile(readFileSync(join(builtinActionsDir(), "brief.md"), "utf8"));
  expect(Either.isRight(parsed)).toBe(true);
  if (Either.isLeft(parsed)) return;
  expect(parsed.right.kind).toBe("prompt");
  expect(parsed.right.target).toBe("agent");
  // Not submitted: the text waits in the agent's editor for you to read.
  expect(parsed.right.submit).toBe(false);
  expect(parsed.right.phases).toEqual(["Ideation"]);
});

test("the shipped brief names the change, its state and its plan", () => {
  const brief = builtinActionBody("brief");
  const text = renderActionBody(
    brief,
    {
      id: "idea-prompt",
      title: "Prompt Me",
      branch: "idea-prompt",
      plan: "/changes/idea-prompt/PLAN.md",
      state: "Ideation",
    },
    "text",
  );
  expect(text).toContain("Prompt Me");
  expect(text).toContain("idea-prompt");
  expect(text).toContain("/changes/idea-prompt/PLAN.md");
  expect(text).toContain("Ideation");
  // A change with no title falls back to its id rather than leaving a hole in the prompt.
  expect(renderActionBody(brief, { id: "idea-prompt", plan: "/p/PLAN.md" }, "text")).toContain(
    "idea-prompt",
  );
});
