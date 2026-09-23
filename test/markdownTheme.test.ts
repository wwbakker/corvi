import { expect, test } from "bun:test";
import {
  markdownHighlighting,
  roleStyles,
  tokenRoles,
  type TokenRole,
} from "../apps/web/src/editor/client/theme.ts";

/**
 * What "colored like an editor" means, pinned as data: which role each syntax tag plays and what
 * each role wears. The editor only renders these tables, so a change of the look is a change
 * here — the page test checks the colors survive to the DOM, this says what they mean.
 */

/** The role a syntax tag plays, found by the tag's name (a `Tag` prints its name). */
const roleOf = (name: string): TokenRole | undefined => {
  for (const [tag, role] of tokenRoles) if (tag.toString() === name) return role;
  return undefined;
};

test("a construct's content wears its structure, its marks wear dim punctuation", () => {
  // Content carries the color of what it sits in...
  expect(roleOf("heading1")).toBe("heading");
  expect(roleOf("heading6")).toBe("heading");
  expect(roleOf("monospace")).toBe("code");
  expect(roleOf("link")).toBe("link");
  expect(roleOf("url")).toBe("link");
  expect(roleOf("string")).toBe("link");
  expect(roleOf("character")).toBe("link");
  expect(roleOf("labelName")).toBe("link");
  expect(roleOf("quote")).toBe("quote");
  expect(roleOf("comment")).toBe("quote");

  // ...and the marks around it — `#`, `**`, `[]()`, the fence lines, escapes, a rule — are dim
  // punctuation. A mark also carries its construct's tag (the `#` is `heading1` and
  // `processingInstruction`), and the mark must win: that is the mark entries' place in the
  // highlight style, last.
  expect(roleOf("processingInstruction")).toBe("mark");
  expect(roleOf("escape")).toBe("mark");
  expect(roleOf("contentSeparator")).toBe("mark");
});

test("emphasis is weight, slant and strike rather than color", () => {
  expect(roleOf("strong")).toBe("strong");
  expect(roleOf("emphasis")).toBe("emphasis");
  expect(roleOf("strikethrough")).toBe("strikethrough");
});

test("code in a known fence wears the same roles", () => {
  // The fenced languages' grammars speak in their own tags, mapped onto the same roles:
  // keywords and names share the heading's blue without its weight, literals the link purple
  // (strings and their subtags reach it through `string`), punctuation and operators the dim
  // marks. Their subtags — `definitionKeyword`, `separator`, `brace`, `attributeValue` and the
  // rest — reach these entries through their parents' chain, which the plan tab's page test
  // pins end to end.
  expect(roleOf("keyword")).toBe("keyword");
  expect(roleOf("propertyName")).toBe("keyword");
  expect(roleOf("tagName")).toBe("keyword");
  expect(roleOf("punctuation")).toBe("mark");
  expect(roleOf("operator")).toBe("mark");
});

test("a role's style is its token's color, with nothing invented at the call site", () => {
  expect(roleStyles.heading).toEqual({ color: "var(--md-heading)", fontWeight: "bold" });
  expect(roleStyles.code).toEqual({ color: "var(--md-code)" });
  expect(roleStyles.link).toEqual({ color: "var(--md-link)" });
  expect(roleStyles.quote).toEqual({ color: "var(--md-quote)", fontStyle: "italic" });
  expect(roleStyles.keyword).toEqual({ color: "var(--md-heading)" });
  expect(roleStyles.strong).toEqual({ fontWeight: "bold" });
  expect(roleStyles.emphasis).toEqual({ fontStyle: "italic" });
  expect(roleStyles.strikethrough).toEqual({ textDecorationLine: "line-through" });
  // A mark carries none of its content's decoration: not bold inside a heading, not struck
  // inside struck text.
  expect(roleStyles.mark).toEqual({
    color: "var(--md-mark)",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecorationLine: "none",
  });
});

test("ordinary text wears no role at all", () => {
  // The paragraph's own text (`content`), list markers' content, names in code: the editor's
  // default color, so structure is the exception rather than the rule.
  expect(roleOf("content")).toBeUndefined();
  expect(roleOf("list")).toBeUndefined();
  expect(roleOf("name")).toBeUndefined();
});

test("the marks are styled last, so a mark sheds its content's decoration", () => {
  // A mark carries its construct's tag as well — the `**` of strong text is `strong` too — and
  // the generated rules resolve that by order: the mark's rule comes after every other, so it
  // decides the color and takes the weight, slant and strike back off the punctuation.
  const rules = markdownHighlighting.module?.getRules() ?? "";
  expect(rules.indexOf("var(--md-heading)")).toBeLessThan(rules.lastIndexOf("var(--md-mark)"));
  expect(rules.indexOf("var(--md-link)")).toBeLessThan(rules.lastIndexOf("var(--md-mark)"));
  expect(rules.indexOf("font-weight: bold")).toBeLessThan(rules.lastIndexOf("font-weight: normal"));
});
