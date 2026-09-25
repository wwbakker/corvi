import { expect, test } from "bun:test";

import { fieldAtLine } from "../apps/web/src/actions/caretField.ts";

/** A file as the editor holds it, indexed for the cases below. */
const file = [
  "---", // 1: the opening marker
  "label: Review", // 2
  "kind: prompt", // 3
  "target: new", // 4
  "start: pi", // 5
  "phases:", // 6
  "  - Ideation", // 7: a phase list belongs to `phases`
  "  - Verification", // 8
  "", // 9: a blank line belongs to no field
  "# a note", // 10: neither does a comment
  "description: for pi", // 11: an undocumented key reports itself
  "---", // 12: the closing marker
  "Look it over.", // 13: the body
  "Then send it.", // 14
].join("\n");

test("a key line names its field", () => {
  expect(fieldAtLine(file, 2)).toBe("label");
  expect(fieldAtLine(file, 3)).toBe("kind");
  expect(fieldAtLine(file, 6)).toBe("phases");
});

test("a continuation line belongs to the field above it", () => {
  expect(fieldAtLine(file, 7)).toBe("phases");
  expect(fieldAtLine(file, 8)).toBe("phases");
});

test("the markers, a blank line and a comment belong to no field", () => {
  expect(fieldAtLine(file, 1)).toBeUndefined();
  expect(fieldAtLine(file, 12)).toBeUndefined();
  expect(fieldAtLine(file, 9)).toBeUndefined();
  expect(fieldAtLine(file, 10)).toBeUndefined();
});

test("below the frontmatter is the body", () => {
  expect(fieldAtLine(file, 13)).toBe("body");
  expect(fieldAtLine(file, 14)).toBe("body");
});

test("an undocumented key reports itself — the panel is the one that stays quiet", () => {
  expect(fieldAtLine(file, 11)).toBe("description");
});

test("a file without frontmatter has no fields at all", () => {
  const prose = "Just words.\nMore words.";
  expect(fieldAtLine(prose, 1)).toBeUndefined();
  expect(fieldAtLine(prose, 2)).toBeUndefined();
});

test("a file still being written maps every line below its opening marker", () => {
  const half = "---\nkind: prompt\nsubmit: true";
  expect(fieldAtLine(half, 2)).toBe("kind");
  expect(fieldAtLine(half, 3)).toBe("submit");
});

test("a continuation before any key is nobody's", () => {
  expect(fieldAtLine("---\n  - stray\n---\nbody", 2)).toBeUndefined();
});

test("CRLF line endings read the same", () => {
  expect(fieldAtLine("---\r\nkind: prompt\r\n---\r\nbody", 2)).toBe("kind");
  expect(fieldAtLine("---\r\nkind: prompt\r\n---\r\nbody", 4)).toBe("body");
});

test("a line past the end is nobody's", () => {
  expect(fieldAtLine(file, 99)).toBeUndefined();
  expect(fieldAtLine(file, 0)).toBeUndefined();
});
