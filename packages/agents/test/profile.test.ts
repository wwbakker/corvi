import { testTempDir } from "@corvi/test-support/temp";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { builtinProfilesDir, readProfileScope } from "../src/node/index.ts";
import { parseProfileFile } from "../src/profile.ts";
import { mergeProfileFiles, type ProfileFileInput } from "../src/discovery.ts";
test("every shipped profile is a valid profile file", () => {
  const names = readdirSync(builtinProfilesDir())
    .filter((name) => name.endsWith(".md"))
    .sort();
  expect(names).toEqual(["reviewer.md"]);
  for (const name of names) {
    const parsed = parseProfileFile(readFileSync(join(builtinProfilesDir(), name), "utf8"));
    expect(Result.isSuccess(parsed)).toBe(true);
  }
});
test("a profile is parsed, and unknown frontmatter keys are tolerated", () => {
  const parsed = parseProfileFile(
    [
      "---",
      "label: Reviewer",
      "harness: pi",
      "model: zai/glm-5.3-flash",
      "effort: high",
      "phases: [Implementation, Verification]",
      "description: for pi's own use",
      "---",
      "Review {prompt}",
    ].join("\n"),
  );
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) {
    expect(parsed.success).toEqual({
      label: "Reviewer",
      harness: "pi",
      model: "zai/glm-5.3-flash",
      effort: "high",
      phases: ["Implementation", "Verification"],
      body: "Review {prompt}",
      extensions: { include: [], exclude: [] },
      skills: { include: [], exclude: [] },
      packages: { include: [], exclude: [] },
      mcp: { include: [], exclude: [] },
    });
  }
});
test("a file that is not a profile is refused with the reasons", () => {
  const missing = parseProfileFile("---\nlabel: X\n---\nbody");
  expect(Result.isSuccess(missing)).toBe(true);
  if (Result.isSuccess(missing)) expect(missing.success.harness).toBeUndefined();
  const badHarness = parseProfileFile("---\nlabel: X\nharness: cursor\nagent: cursor\n---\nbody");
  expect(Result.isFailure(badHarness)).toBe(true);
  const badModel = parseProfileFile("---\nlabel: X\nharness: pi\nmodel: 7\n---\nbody");
  expect(Result.isFailure(badModel)).toBe(true);
  const noFrontmatter = parseProfileFile("just a body");
  expect(Result.isFailure(noFrontmatter)).toBe(true);
});

test("harness is a harness id, not only pi or opencode", () => {
  const parsed = parseProfileFile("---\nlabel: X\nharness: review-env\n---\nbody");
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) expect(parsed.success.harness).toBe("review-env");
});

test("a profile carries the harness sections too", () => {
  const parsed = parseProfileFile(
    [
      "---",
      "label: X",
      "harness: pi-bare",
      "skills: { exclude: [spiega] }",
      "instructions: |",
      "  Be terse.",
      "enabledModels: [a/b, c/d]",
      "---",
      "body",
    ].join("\n"),
  );
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) {
    expect(parsed.success.skills).toEqual({ include: [], exclude: ["spiega"] });
    expect(parsed.success.instructions).toBe("Be terse.\n");
    expect(parsed.success.enabledModels).toEqual(["a/b", "c/d"]);
  }
});
test("an empty phases list means every phase, not none", () => {
  const parsed = parseProfileFile("---\nlabel: X\nharness: pi\nphases: []\n---\nbody");
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) expect(parsed.success.phases).toBeUndefined();
});
test("a file that cannot be read, or does not parse, is skipped with its reasons", () => {
  const merged = mergeProfileFiles([
    { id: "good", source: "global", text: "---\nlabel: Good\nharness: pi\n---\nbody" },
    { id: "unreadable", source: "global", text: "", readable: false },
    { id: "empty", source: "global", text: "" },
  ]);
  expect(merged.profiles.map((profile) => profile.id)).toEqual(["good"]);
  const reasons = Object.fromEntries(merged.skipped.map((file) => [file.key, file.reasons.join("; ")]));
  expect(reasons["global:unreadable"]).toContain("cannot read");
  expect(reasons["global:empty"]).toContain("frontmatter");
});
test("a scope reader returns files, and a missing directory is an empty scope", async () => {
  const dir = await testTempDir("agents-profile-scope");
  try {
    expect(await Effect.runPromise(readProfileScope(join(dir, "nope")))).toEqual([]);
    await writeFile(join(dir, "one.md"), "---\nlabel: One\nharness: pi\n---\nbody", "utf8");
    const files = await Effect.runPromise(readProfileScope(dir));
    expect(files.map((file) => file.id)).toEqual(["one"]);
    expect(files[0]?.readable).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("a more specific scope shadows a less specific one, and repositories are all kept", () => {
  const file = (
    source: ProfileFileInput["source"],
    id: string,
    origin?: string,
    label = id,
  ): ProfileFileInput => ({
    id,
    source,
    origin,
    originLabel: origin,
    text: `---\nlabel: ${label}\nharness: pi\n---\nbody`,
  });
  const merged = mergeProfileFiles([
    file("builtin", "reviewer", undefined, "Built-in"),
    file("global", "reviewer", undefined, "Global"),
    file("workspace", "reviewer", "personal", "Workspace"),
    file("repository", "reviewer", "orders-api", "Orders"),
    file("repository", "reviewer", "billing", "Billing"),
  ]);
  const found = merged.profiles.map((profile) => profile.key).sort();
  // A repository file shadows the more general scopes outright; each repository keeps its own.
  expect(found).toEqual(["repository:billing:reviewer", "repository:orders-api:reviewer"]);
});
test("without a repository file, the most specific scope wins", () => {
  const file = (source: ProfileFileInput["source"], id: string, label = id): ProfileFileInput => ({
    id,
    source,
    text: `---\nlabel: ${label}\nharness: pi\n---\nbody`,
  });
  const merged = mergeProfileFiles([
    file("builtin", "reviewer", "Built-in"),
    file("global", "reviewer", "Global"),
  ]);
  expect(merged.profiles.map((profile) => profile.key)).toEqual(["global:reviewer"]);
});
