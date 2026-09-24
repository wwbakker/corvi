import { test, expect } from "bun:test";
import { firstHeading, setFirstHeading } from "../apps/web/src/wizard/plan.ts";

/**
 * The plan document's rules: the first `#` heading names the change, and only that line is ever
 * rewritten — by a picked issue, while the heading is still what the template put there.
 */

test("the first heading is the title, empty when there is none", () => {
  expect(firstHeading("# The thing\n\nSome words.")).toBe("The thing");
  // Whitespace around the title is not part of it.
  expect(firstHeading("#   Spaced   \n")).toBe("Spaced");
  // A heading further down still counts; a bare # is an empty heading and stops the scan.
  expect(firstHeading("intro\n\n## Not this one\n# But this one")).toBe("But this one");
  expect(firstHeading("#\n# Later")).toBe("");
  // `#tag` is not a heading (CommonMark), and a six-mark heading is not an h1.
  expect(firstHeading("#tag is a tag")).toBe("");
  expect(firstHeading("###### Six")).toBe("");
  expect(firstHeading("no headings here")).toBe("");
});

test("setting the heading rewrites that one line, or adds it on top", () => {
  expect(setFirstHeading("# Old\n\ntext\n", "New")).toBe("# New\n\ntext\n");
  // The blank heading of a scaffold is filled in place, line and document shape intact.
  expect(setFirstHeading("#\n\n## Context\n", "Named")).toBe("# Named\n\n## Context\n");
  expect(setFirstHeading("text only\n", "Named")).toBe("# Named\n\ntext only\n");
  expect(setFirstHeading("", "Named")).toBe("# Named\n");
});
