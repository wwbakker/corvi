import { expect, test } from "bun:test";
import { fencedCodeLanguages } from "../apps/web/src/editor/client/languages.ts";

/**
 * The curated fenced-code set: what a fence may name. The plan tab's page test pins what one of
 * them looks like; this pins the list itself, so adding (or losing) a language is a deliberate
 * edit here and in the bundle it grows.
 */

test("a fence may name the curated languages", () => {
  expect(fencedCodeLanguages.map((language) => language.name).sort()).toEqual([
    "bash",
    "css",
    "html",
    "java",
    "javascript",
    "json",
    "kotlin",
    "python",
    "scala",
    "sql",
    "typescript",
    "yaml",
  ]);
});

test("every language is already constructed, so its first fence is colored at once", () => {
  for (const language of fencedCodeLanguages) {
    expect(language.support).not.toBeNull();
  }
});
