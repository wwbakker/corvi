import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";

import { builtinHarnessProfilesDir } from "../src/node/index.ts";
import {
  mergeHarnessProfileFields,
  parseHarnessProfileFields,
  type HarnessProfileFields,
} from "../src/harnessProfileFields.ts";
import { BUILTIN_HARNESS_PROFILE_IDS, parseHarnessProfileFile } from "../src/harnessProfileFile.ts";

/** The fields of a frontmatter object, without the profile it is based on (which is not a setting). */
const fieldsOf = (source: Record<string, unknown>): HarnessProfileFields => {
  const parsed = parseHarnessProfileFields(source);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.reasons.join("; "));
  const { basedOnHarnessProfile: _base, ...fields } = parsed.success;
  return fields;
};

test("every shipped harness is a valid harness profile file, and every chain ends at one", () => {
  const names = readdirSync(builtinHarnessProfilesDir())
    .filter((name) => name.endsWith(".md"))
    .sort();
  expect(names).toEqual(["opencode.md", "pi-bare.md", "pi.md"]);
  const ids = names.map((name) => name.slice(0, -3));
  expect([...ids].sort()).toEqual([...BUILTIN_HARNESS_PROFILE_IDS].sort());
  for (const name of names) {
    const parsed = parseHarnessProfileFile(readFileSync(join(builtinHarnessProfilesDir(), name), "utf8"));
    expect(Result.isSuccess(parsed)).toBe(true);
  }
  const bare = parseHarnessProfileFile(readFileSync(join(builtinHarnessProfilesDir(), "pi-bare.md"), "utf8"));
  expect(Result.isSuccess(bare)).toBe(true);
  if (Result.isSuccess(bare)) {
    // The program is inherited through the base; the file itself only narrows the sections.
    expect(bare.success.basedOnHarnessProfile).toBe("pi");
    expect(bare.success.harness).toBeUndefined();
    expect(bare.success.extensions).toEqual({ mode: "none", include: [], exclude: [] });
    expect(bare.success.skills).toEqual({ mode: "none", include: [], exclude: [] });
  }
  const opencode = parseHarnessProfileFile(
    readFileSync(join(builtinHarnessProfilesDir(), "opencode.md"), "utf8"),
  );
  expect(Result.isSuccess(opencode)).toBe(true);
  if (Result.isSuccess(opencode)) expect(opencode.success.harness).toBe("opencode");
});

test("a harness profile file parses the whole vocabulary, and the body is notes", () => {
  const parsed = parseHarnessProfileFile(
    [
      "---",
      "label: Reviewer environment",
      "basedOnHarnessProfile: pi-bare",
      "harness: pi",
      "model: mistral/deepseek-v4-1-flash-1017",
      "effort: low",
      "enabledModels: [deepseek/deepseek-flash, zai/glm-5.3-flash]",
      "instructions: |",
      "  Be terse.",
      "extensions: { mode: none, include: [some-extension] }",
      "skills: { exclude: [spiega] }",
      "packages: { mode: all, exclude: [pi-footer-wessel] }",
      "mcp: { mode: none }",
      "---",
      "Free-form notes for the reader.",
    ].join("\n"),
  );
  expect(Result.isSuccess(parsed)).toBe(true);
  if (!Result.isSuccess(parsed)) return;
  expect(parsed.success.label).toBe("Reviewer environment");
  expect(parsed.success.basedOnHarnessProfile).toBe("pi-bare");
  expect(parsed.success.harness).toBe("pi");
  expect(parsed.success.model).toBe("mistral/deepseek-v4-1-flash-1017");
  expect(parsed.success.effort).toBe("low");
  expect(parsed.success.enabledModels).toEqual(["deepseek/deepseek-flash", "zai/glm-5.3-flash"]);
  expect(parsed.success.instructions).toBe("Be terse.\n");
  expect(parsed.success.extensions).toEqual({ mode: "none", include: ["some-extension"], exclude: [] });
  expect(parsed.success.skills).toEqual({ include: [], exclude: ["spiega"] });
  expect(parsed.success.packages).toEqual({ mode: "all", include: [], exclude: ["pi-footer-wessel"] });
  expect(parsed.success.mcp).toEqual({ mode: "none", include: [], exclude: [] });
});

test("a file that is not a harness is refused with the reasons", () => {
  const noFrontmatter = parseHarnessProfileFile("just notes");
  expect(Result.isFailure(noFrontmatter)).toBe(true);

  const noLabel = parseHarnessProfileFile("---\nharness: pi\n---\nnotes");
  expect(Result.isFailure(noLabel)).toBe(true);
  if (Result.isFailure(noLabel)) expect(noLabel.failure.reasons.join("; ")).toContain("label");

  const badAgent = parseHarnessProfileFile("---\nlabel: X\nharness: cursor\n---\nnotes");
  expect(Result.isFailure(badAgent)).toBe(true);
  if (Result.isFailure(badAgent)) expect(badAgent.failure.reasons.join("; ")).toContain("harness");

  const badSection = parseHarnessProfileFile("---\nlabel: X\nharness: pi\nskills: [spiega]\n---\nnotes");
  expect(Result.isFailure(badSection)).toBe(true);
  if (Result.isFailure(badSection)) expect(badSection.failure.reasons.join("; ")).toContain("skills");

  const badInclude = parseHarnessProfileFile(
    "---\nlabel: X\nharness: pi\nmcp: { include: spiega }\n---\nnotes",
  );
  expect(Result.isFailure(badInclude)).toBe(true);
  if (Result.isFailure(badInclude)) expect(badInclude.failure.reasons.join("; ")).toContain("include");
});

test("an absent section is empty; a present one keeps its lists", () => {
  expect(fieldsOf({})).toEqual({
    extensions: { include: [], exclude: [] },
    skills: { include: [], exclude: [] },
    packages: { include: [], exclude: [] },
    mcp: { include: [], exclude: [] },
  });
  const fields = fieldsOf({ skills: null });
  expect(fields.skills).toEqual({ include: [], exclude: [] });
});

test("a child mode replaces the section; without one, lists append to the parent's", () => {
  const parent = fieldsOf({
    extensions: { mode: "all", exclude: ["noisy"] },
    skills: { mode: "none", include: ["spiega"] },
  });
  const childMode = fieldsOf({ extensions: { mode: "none", include: ["mine"] } });
  const mergedMode = mergeHarnessProfileFields(parent, childMode);
  expect(mergedMode.extensions).toEqual({ mode: "none", include: ["mine"], exclude: [] });

  const childLists = fieldsOf({ extensions: { exclude: ["mine"] }, skills: { exclude: ["other"] } });
  const mergedLists = mergeHarnessProfileFields(parent, childLists);
  expect(mergedLists.extensions).toEqual({ mode: "all", include: [], exclude: ["noisy", "mine"] });
  expect(mergedLists.skills).toEqual({ mode: "none", include: ["spiega"], exclude: ["other"] });
});

test("scalars: the child wins, and an absent child inherits", () => {
  const parent = fieldsOf({ model: "parent/model", effort: "high", instructions: "parent rules" });
  const child = fieldsOf({ effort: "low", instructions: "" });
  const merged = mergeHarnessProfileFields(parent, child);
  expect(merged.model).toBe("parent/model");
  expect(merged.effort).toBe("low");
  expect(merged.instructions).toBe("");
});
