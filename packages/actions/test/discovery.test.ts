import { expect, test } from "bun:test";

import { keyOf, mergeActionFiles, resolveBriefTemplate, type ActionFileInput } from "../src/discovery.ts";

const file = (input: Partial<ActionFileInput> & { id: string; source: ActionFileInput["source"] }): ActionFileInput => ({
  text: "---\nlabel: Run\nclass: ignored\nkind: command\ntarget: new\n---\nbun test\n",
  ...input,
});

test("the shadowing and fallback chain the product keeps", () => {
  // The whole chain, pinned: repository > workspace > global > built-in for the files, then the
  // legacy ideationPrompt setting, then the shipped body. Two repositories are not a collision.
  const merged = mergeActionFiles([
    file({ id: "test", source: "builtin" }),
    file({ id: "test", source: "global" }),
    file({ id: "test", source: "workspace", origin: "personal" }),
    file({ id: "test", source: "repository", origin: "orders-api" }),
    file({ id: "test", source: "repository", origin: "billing" }),
    file({ id: "brief", source: "builtin" }),
    file({ id: "solo", source: "global" }),
  ]);
  expect(merged.actions.map((a) => a.key)).toEqual([
    "repository:orders-api:test",
    "repository:billing:test",
    "builtin:brief",
    "global:solo",
  ]);
  expect(merged.actions[0]?.sourceLabel).toBe("orders-api");

  // Below the file chain, the brief's own text chain: with no user `brief.md`, the legacy
  // setting is next — the built-in is not a shadow of itself.
  expect(
    resolveBriefTemplate({ actions: merged.actions, ideationPrompt: "legacy text", shippedBody: "shipped" }),
  ).toBe("legacy text");
});

test("a brief.md anywhere shadows the built-in brief whole", () => {
  const merged = mergeActionFiles([
    file({ id: "brief", source: "builtin" }),
    file({ id: "brief", source: "global", text: "---\nlabel: Mine\nkind: prompt\ntarget: agent\n---\nmy text\n" }),
  ]);
  expect(merged.actions.map((a) => a.key)).toEqual(["global:brief"]);
  expect(
    resolveBriefTemplate({ actions: merged.actions, ideationPrompt: "legacy text", shippedBody: "shipped" }),
  ).toBe("my text");
});

test("the brief chain: shadow, then the legacy setting, then the shipped body", () => {
  const shadow = mergeActionFiles([
    file({ id: "brief", source: "workspace", origin: "personal", text: "---\nlabel: Mine\nkind: prompt\ntarget: agent\n---\nshadow\n" }),
  ]).actions;
  expect(resolveBriefTemplate({ actions: shadow, ideationPrompt: "legacy", shippedBody: "shipped" })).toBe("shadow");
  const none = mergeActionFiles([file({ id: "brief", source: "builtin" })]).actions;
  expect(resolveBriefTemplate({ actions: none, ideationPrompt: "legacy", shippedBody: "shipped" })).toBe("legacy");
  expect(resolveBriefTemplate({ actions: none, ideationPrompt: "", shippedBody: "shipped" })).toBe("shipped");
});

test("a malformed file is skipped with its reasons and never takes the menu down", () => {
  const merged = mergeActionFiles([
    file({ id: "bad", source: "global", text: "---\nkind: command\n---\nrm -rf\n" }),
    file({ id: "good", source: "global" }),
  ]);
  expect(merged.actions.map((a) => a.key)).toEqual(["global:good"]);
  expect(merged.skipped).toEqual([{ key: "global:bad", reasons: ["label: required, a string"] }]);
});

test("keys name the file's place", () => {
  expect(keyOf("builtin", undefined, "brief")).toBe("builtin:brief");
  expect(keyOf("global", undefined, "test")).toBe("global:test");
  expect(keyOf("workspace", "personal", "test")).toBe("workspace:personal:test");
  expect(keyOf("repository", "orders-api", "test")).toBe("repository:orders-api:test");
});
