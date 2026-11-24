import { testTempDir } from "@corvi/test-support/temp";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { builtinSubagentProfilesDir, readSubagentProfileScope } from "../src/node/index.ts";
import { parseSubagentProfileFile } from "../src/subagentProfile.ts";
import { mergeSubagentProfileFiles, type SubagentProfileFileInput } from "../src/subagentProfileDiscovery.ts";
test("every shipped profile is a valid profile file", () => {
  const names = readdirSync(builtinSubagentProfilesDir())
    .filter((name) => name.endsWith(".md"))
    .sort();
  expect(names).toEqual(["reviewer.md"]);
  for (const name of names) {
    const parsed = parseSubagentProfileFile(readFileSync(join(builtinSubagentProfilesDir(), name), "utf8"));
    expect(Result.isSuccess(parsed)).toBe(true);
  }
});
test("a profile is parsed, and unknown frontmatter keys are tolerated", () => {
  const parsed = parseSubagentProfileFile(
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
  const missing = parseSubagentProfileFile("---\nlabel: X\n---\nbody");
  expect(Result.isSuccess(missing)).toBe(true);
  if (Result.isSuccess(missing)) expect(missing.success.harness).toBeUndefined();
  const badHarness = parseSubagentProfileFile("---\nlabel: X\nharness: cursor\n---\nbody");
  expect(Result.isFailure(badHarness)).toBe(true);
  const badModel = parseSubagentProfileFile("---\nlabel: X\nharness: pi\nmodel: 7\n---\nbody");
  expect(Result.isFailure(badModel)).toBe(true);
  const noFrontmatter = parseSubagentProfileFile("just a body");
  expect(Result.isFailure(noFrontmatter)).toBe(true);
});

test("harness names the program; a harness profile goes in basedOnHarnessProfile", () => {
  const plain = parseSubagentProfileFile("---\nlabel: X\nharness: opencode\n---\nbody");
  expect(Result.isSuccess(plain)).toBe(true);
  if (Result.isSuccess(plain)) expect(plain.success.harness).toBe("opencode");

  const based = parseSubagentProfileFile("---\nlabel: X\nbasedOnHarnessProfile: review-env\n---\nbody");
  expect(Result.isSuccess(based)).toBe(true);
  if (Result.isSuccess(based)) expect(based.success.basedOnHarnessProfile).toBe("review-env");

  // An id in `harness:` is a reason, not a base by another name.
  const wrong = parseSubagentProfileFile("---\nlabel: X\nharness: review-env\n---\nbody");
  expect(Result.isFailure(wrong)).toBe(true);
  if (Result.isFailure(wrong)) expect(wrong.failure.reasons.join("; ")).toContain("harness: pi or opencode");
});

test("a profile carries the harness sections too", () => {
  const parsed = parseSubagentProfileFile(
    [
      "---",
      "label: X",
      "basedOnHarnessProfile: pi-bare",
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
  const parsed = parseSubagentProfileFile("---\nlabel: X\nharness: pi\nphases: []\n---\nbody");
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) expect(parsed.success.phases).toBeUndefined();
});
test("a file that cannot be read, or does not parse, is skipped with its reasons", () => {
  const merged = mergeSubagentProfileFiles([
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
    expect(await Effect.runPromise(readSubagentProfileScope(join(dir, "nope")))).toEqual([]);
    await writeFile(join(dir, "one.md"), "---\nlabel: One\nharness: pi\n---\nbody", "utf8");
    const files = await Effect.runPromise(readSubagentProfileScope(dir));
    expect(files.map((file) => file.id)).toEqual(["one"]);
    expect(files[0]?.readable).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("a more specific scope shadows a less specific one, and repositories are all kept", () => {
  const file = (
    source: SubagentProfileFileInput["source"],
    id: string,
    origin?: string,
    label = id,
  ): SubagentProfileFileInput => ({
    id,
    source,
    origin,
    originLabel: origin,
    text: `---\nlabel: ${label}\nharness: pi\n---\nbody`,
  });
  const merged = mergeSubagentProfileFiles([
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
  const file = (
    source: SubagentProfileFileInput["source"],
    id: string,
    label = id,
  ): SubagentProfileFileInput => ({
    id,
    source,
    text: `---\nlabel: ${label}\nharness: pi\n---\nbody`,
  });
  const merged = mergeSubagentProfileFiles([
    file("builtin", "reviewer", "Built-in"),
    file("global", "reviewer", "Global"),
  ]);
  expect(merged.profiles.map((profile) => profile.key)).toEqual(["global:reviewer"]);
});
