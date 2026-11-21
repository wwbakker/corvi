import { test, expect } from "bun:test";
import { firstHeading, firstHeadingRange, setFirstHeading } from "../apps/web/src/wizard/plan.ts";

/**
 * The plan document's rules: the first `#` heading names the change, and only that line is ever
 * rewritten — by a picked issue, while the heading is still what the template put there. The
 * wizard also opens on that heading, so its text's positions are part of the rule.
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

test("a heading's text is its own range in the document", () => {
  // The title without its marks: selecting that range is what makes typing replace the title.
  expect(firstHeadingRange("# The thing\n\nSome words.")).toEqual({ from: 2, to: 11 });
  expect(firstHeadingRange("#   Spaced   \n")).toEqual({ from: 4, to: 10 });
  expect(firstHeadingRange("intro\n# Later\n")).toEqual({ from: 8, to: 13 });
  // A heading with no text is a range of nothing after the marks: a caret, not a selection.
  expect(firstHeadingRange("# ")).toEqual({ from: 2, to: 2 });
  // A bare # has nothing after it: the caret goes straight after the mark.
  expect(firstHeadingRange("#\n")).toEqual({ from: 1, to: 1 });
  expect(firstHeadingRange("no headings here")).toBeNull();
  // The shipped default: a lone heading line, names nothing until a title is typed.
  expect(firstHeading("# ")).toBe("");
});

test("setting the heading rewrites that one line, or adds it on top", () => {
  expect(setFirstHeading("# Old\n\ntext\n", "New")).toBe("# New\n\ntext\n");
  // The blank heading of a scaffold is filled in place, line and document shape intact.
  expect(setFirstHeading("#\n\n## Context\n", "Named")).toBe("# Named\n\n## Context\n");
  expect(setFirstHeading("text only\n", "Named")).toBe("# Named\n\ntext only\n");
  expect(setFirstHeading("", "Named")).toBe("# Named\n");
});
