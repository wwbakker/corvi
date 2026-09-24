import { expect, test } from "bun:test";

import { renderActionBody, shellQuote } from "../src/render.ts";

const facts = {
  id: "PROJ-1",
  title: "It's a title",
  branch: "PROJ-1-title",
  plan: "/home/me/corvi/changes/PROJ-1/PLAN.md",
  state: "Ideation",
  dir: "/home/me/corvi/changes/PROJ-1",
  repos: ["orders-api", "billing"],
};

test("every placeholder fills with the change's facts", () => {
  const out = renderActionBody(
    "{id} | {title} | {branch} | {plan} | {state} | {dir} | {repos}",
    facts,
    "text",
  );
  expect(out).toBe(
    "PROJ-1 | It's a title | PROJ-1-title | /home/me/corvi/changes/PROJ-1/PLAN.md | Ideation | /home/me/corvi/changes/PROJ-1 | orders-api, billing",
  );
});

test("a placeholder typo leaves no hole: title falls back to branch then id, state to its phase", () => {
  expect(renderActionBody("{title}", { ...facts, title: undefined }, "text")).toBe("PROJ-1-title");
  expect(renderActionBody("{title}", { ...facts, title: undefined, branch: undefined }, "text")).toBe("PROJ-1");
  expect(renderActionBody("{state}", { ...facts, state: undefined }, "text")).toBe("Implementation");
  expect(renderActionBody("{repos}", { ...facts, repos: undefined }, "text")).toBe("");
});

test("a command gets the values shell-escaped; a prompt gets them as written", () => {
  const template = "echo {title}";
  expect(renderActionBody(template, facts, "text")).toBe("echo It's a title");
  expect(renderActionBody(template, facts, "shell")).toBe("echo 'It'\\''s a title'");
});

test("shell quoting survives whatever a Jira title contains", () => {
  expect(shellQuote("plain")).toBe("'plain'");
  expect(shellQuote("it's $(rm -rf /)")).toBe("'it'\\''s $(rm -rf /)'");
});
