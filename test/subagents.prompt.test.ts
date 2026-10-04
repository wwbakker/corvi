/** The subagent body rule table: the profile's body rendered with the change facts plus the
 * caller's task, and the three places an absent task still yields a first message. */
import { expect, test } from "bun:test";

import {
  AWAIT_INSTRUCTIONS,
  renderSubagentBody,
} from "../apps/server/src/subagents/server/prompt.ts";
import type { ChangeFacts } from "../apps/server/src/change/server/facts.ts";

const facts: ChangeFacts = {
  id: "PROJ-1",
  title: "It's a title",
  branch: "PROJ-1-title",
  plan: "/home/me/corvi/changes/PROJ-1/PLAN.md",
  state: "Implementation",
  dir: "/home/me/corvi/changes/PROJ-1",
  repos: ["orders-api", "billing"],
};

test("a body with {prompt} renders the change facts and the task in place", () => {
  const body = "Review `{id}` ({title}) at {plan}.\n\n{prompt}";
  expect(renderSubagentBody(body, facts, "Focus on the tests")).toBe(
    "Review `PROJ-1` (It's a title) at /home/me/corvi/changes/PROJ-1/PLAN.md.\n\nFocus on the tests",
  );
});

test("a body with {prompt} and no task substitutes the await instruction", () => {
  expect(renderSubagentBody("Do this:\n\n{prompt}", facts, undefined)).toBe(
    `Do this:\n\n${AWAIT_INSTRUCTIONS}`,
  );
  expect(renderSubagentBody("Do this:\n\n{prompt}", facts, "   ")).toBe(
    `Do this:\n\n${AWAIT_INSTRUCTIONS}`,
  );
});

test("a body without {prompt} and a task appends it under a final ## Task section", () => {
  expect(renderSubagentBody("Do the review.", facts, "Focus on tests")).toBe(
    "Do the review.\n\n## Task\n\nFocus on tests",
  );
});

test("a body without {prompt} and no task is the rendered body alone", () => {
  expect(renderSubagentBody("Do the review.", facts, undefined)).toBe("Do the review.");
  expect(renderSubagentBody("Do the review.", facts, "  ")).toBe("Do the review.");
});

test("a body-less profile sends the task alone", () => {
  expect(renderSubagentBody("", facts, "Do it")).toBe("Do it");
  expect(renderSubagentBody("   \n", facts, "Do it")).toBe("Do it");
});

test("a body-less profile with no task sends the await instruction alone", () => {
  expect(renderSubagentBody("", facts, undefined)).toBe(AWAIT_INSTRUCTIONS);
  expect(renderSubagentBody("  \n", facts, "")).toBe(AWAIT_INSTRUCTIONS);
});

test("a task whose own text contains braces is not re-expanded", () => {
  expect(renderSubagentBody("{prompt}", facts, "look at {id} and {plan}")).toBe(
    "look at {id} and {plan}",
  );
});

test("a non-whitespace body that renders to nothing falls back to the task or instruction", () => {
  const noRepos = { ...facts, repos: [] };
  expect(renderSubagentBody("{repos}", noRepos, undefined)).toBe(AWAIT_INSTRUCTIONS);
  expect(renderSubagentBody("{repos}", noRepos, "Do it")).toBe("Do it");
});

test("a task containing braces is appended raw under ## Task, not re-expanded", () => {
  expect(renderSubagentBody("Do the review.", facts, "look at {id} and {plan}")).toBe(
    "Do the review.\n\n## Task\n\nlook at {id} and {plan}",
  );
});
