import { expect, test } from "bun:test";

import { splitFrontmatter } from "../src/frontmatter.ts";

test("frontmatter and body split, and a file without the pair is not one", () => {
  expect(splitFrontmatter("---\nlabel: A\nkind: prompt\n---\nDo the thing.\n")).toEqual({
    fields: { label: "A", kind: "prompt" },
    frontmatter: "label: A\nkind: prompt",
    body: "Do the thing.",
  });
  expect(splitFrontmatter("no frontmatter here")).toBeUndefined();
  expect(splitFrontmatter("---\nlabel: [unclosed\n---\nbody")).toBeUndefined();
});

test("a body-less file and a CRLF block read the same way", () => {
  expect(splitFrontmatter("---\r\nlabel: A\r\n---\r\n")).toEqual({
    fields: { label: "A" },
    frontmatter: "label: A",
    body: "",
  });
});
