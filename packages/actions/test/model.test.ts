import { expect, test } from "bun:test";
import { Either } from "effect";

import { parseActionFile, splitFrontmatter } from "../src/model.ts";

const promptFile = (frontmatter: string, body = "Do the thing."): string =>
  `---\n${frontmatter}\n---\n${body}\n`;

const reasonsOf = (text: string): readonly string[] => {
  const parsed = parseActionFile(text);
  if (Either.isRight(parsed)) throw new Error("expected the file to be refused");
  return parsed.left.reasons;
};

test("a prompt file parses, with the documented defaults", () => {
  const parsed = parseActionFile(promptFile("label: Review\nclass: ignored\nkind: prompt"));
  expect(Either.isRight(parsed)).toBe(true);
  if (Either.isLeft(parsed)) return;
  expect(parsed.right).toEqual({
    label: "Review",
    kind: "prompt",
    target: "active",
    start: undefined,
    submit: false,
    phases: undefined,
    notify: false,
    keepOpen: false,
    body: "Do the thing.",
  });
});

test("a prompt for an agent defaults its start to pi, and phases are kept", () => {
  const parsed = parseActionFile(
    promptFile("label: Brief\nkind: prompt\ntarget: agent\nphases: [Ideation]"),
  );
  expect(Either.isRight(parsed)).toBe(true);
  if (Either.isLeft(parsed)) return;
  expect(parsed.right.start).toBe("pi");
  expect(parsed.right.phases).toEqual(["Ideation"]);
});

test("frontmatter and body split, and a file without the pair is not an action", () => {
  expect(splitFrontmatter(promptFile("label: A\nkind: prompt", "body"))?.body).toBe("body");
  expect(splitFrontmatter("just text")).toBeUndefined();
  expect(reasonsOf("just text")).toEqual(["missing or unparseable YAML frontmatter"]);
});

test("the fields that are required, and the ones that must be one thing", () => {
  expect(reasonsOf(promptFile("kind: prompt"))).toContain("label: required, a string");
  expect(reasonsOf(promptFile("label: A"))).toContain("kind: must be prompt or command");
  expect(reasonsOf(promptFile("label: A\nkind: prompt\ntarget: everywhere"))).toContain(
    "target: must be active, agent or new",
  );
  expect(reasonsOf(promptFile("label: A\nkind: command\nphases: [Soon]"))).toContain(
    "phases: must be a list of the change's phases",
  );
});

test("contradictions are refused rather than ignored", () => {
  // A prompt into a new window without a start would run the text in a shell.
  expect(reasonsOf(promptFile("label: A\nkind: prompt\ntarget: new"))).toContain(
    "start: required, or the prompt would land in a shell",
  );
  // A command has nowhere to paste an agent's text, and always submits.
  expect(reasonsOf(promptFile("label: A\nkind: command\ntarget: agent"))).toContain(
    "target: a command cannot target an agent window",
  );
  expect(reasonsOf(promptFile("label: A\nkind: command\nsubmit: true"))).toContain(
    "submit: applies to prompts; a command always submits",
  );
  expect(reasonsOf(promptFile("label: A\nkind: prompt\nnotify: true"))).toContain(
    "notify: applies to commands",
  );
  expect(reasonsOf(promptFile("label: A\nkind: prompt\nkeepOpen: true"))).toContain(
    "keepOpen: applies to commands",
  );
});

test("a command that keeps its window parses, and unknown keys ride along", () => {
  const parsed = parseActionFile(
    promptFile("label: Run the tests\nkind: command\ntarget: new\nnotify: true\ndescription: pi's own", "bun test"),
  );
  expect(Either.isRight(parsed)).toBe(true);
  if (Either.isLeft(parsed)) return;
  expect(parsed.right.notify).toBe(true);
  expect(parsed.right.keepOpen).toBe(false);
  expect(parsed.right.body).toBe("bun test");
});
