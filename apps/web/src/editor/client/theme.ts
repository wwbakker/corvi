import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";

/**
 * The Markdown editor's look: its chrome, and the colors syntax tokens wear. Every color is a
 * token from `styles.css` — that file stays the only place a color is written down
 * (docs/guides/style.md) — and the emphasis a construct carries is its weight, slant or strike,
 * as source editors present it, with color reserved for structure.
 */

/**
 * What a token does in the document. The five colored roles are the plan's own tokens; strong,
 * emphasis and strikethrough carry no color of their own — they are weight, slant and strike.
 */
export type TokenRole =
  | "heading"
  | "strong"
  | "emphasis"
  | "strikethrough"
  | "code"
  | "link"
  | "quote"
  | "keyword"
  | "mark";

/** The CSS a role paints. */
export type RoleStyle = {
  readonly color?: string;
  readonly fontWeight?: string;
  readonly fontStyle?: string;
  readonly textDecorationLine?: string;
};

/** What each role looks like. */
export const roleStyles: Readonly<Record<TokenRole, RoleStyle>> = {
  heading: { color: "var(--md-heading)", fontWeight: "bold" },
  strong: { fontWeight: "bold" },
  emphasis: { fontStyle: "italic" },
  strikethrough: { textDecorationLine: "line-through" },
  code: { color: "var(--md-code)" },
  link: { color: "var(--md-link)" },
  quote: { color: "var(--md-quote)", fontStyle: "italic" },
  // Code's own structure — keywords and names, tag names — in the heading's blue, without its
  // weight.
  keyword: { color: "var(--md-heading)" },
  // A construct's marks — `#`, `**`, `[]()`, the fence lines, and code's punctuation and
  // operators — not its content: dimmed, and stripped of the content's weight, slant and strike
  // so the punctuation reads as punctuation.
  mark: {
    color: "var(--md-mark)",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecorationLine: "none",
  },
};

/**
 * Which role each syntax tag plays. The tags are the ones `@lezer/markdown` and the fenced
 * languages' grammars put on their trees — a mark carries both its own `processingInstruction`
 * tag and the tag of the construct it opens (the `#` of a heading is `heading1` *and*
 * `processingInstruction`), so the mark entries come last in the highlight style below: on a
 * combined tag, the later definition wins, and the mark must win for the punctuation to stay dim
 * and unstyled. A grammar's subtags — `lineComment`, `separator`, `brace`, `definitionKeyword` —
 * reach their parent's entry here through the tag's own parent chain. Unlisted tags — ordinary
 * paragraph text above all — wear the editor's default color.
 */
export const tokenRoles: ReadonlyMap<Tag, TokenRole> = new Map<Tag, TokenRole>([
  [tags.heading1, "heading"],
  [tags.heading2, "heading"],
  [tags.heading3, "heading"],
  [tags.heading4, "heading"],
  [tags.heading5, "heading"],
  [tags.heading6, "heading"],
  [tags.strong, "strong"],
  [tags.emphasis, "emphasis"],
  [tags.strikethrough, "strikethrough"],
  [tags.monospace, "code"],
  [tags.link, "link"],
  [tags.url, "link"],
  [tags.labelName, "link"],
  [tags.string, "link"],
  [tags.character, "link"],
  [tags.quote, "quote"],
  [tags.comment, "quote"],
  // Code, in a fence whose language the editor knows (languages.ts): keywords and names wear the
  // heading's blue, literals the link purple (strings and their subtags reach it through the
  // entries above), comments the quote grey.
  [tags.keyword, "keyword"],
  [tags.propertyName, "keyword"],
  [tags.tagName, "keyword"],
  // The marks, last: see above.
  [tags.processingInstruction, "mark"],
  [tags.escape, "mark"],
  [tags.contentSeparator, "mark"],
  [tags.punctuation, "mark"],
  [tags.operator, "mark"],
]);

/** The highlight style the editor installs, built from the two tables above. */
export const markdownHighlighting: HighlightStyle = HighlightStyle.define(
  [...tokenRoles].map(([tag, role]) => ({ tag, ...roleStyles[role] })),
);

/** The editor's chrome: the well it is cut into and the monospace face it is written in. */
export const editorChrome = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--well)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: "1.5",
  },
  ".cm-content": {
    padding: "8px",
    caretColor: "var(--text)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text)",
  },
  ".cm-placeholder": {
    color: "var(--faint)",
    fontStyle: "normal",
  },
  /* The line the caret is on, the echo of a selection, and a trailing space: the same faint
     wash, present rather than loud. */
  ".cm-activeLine, .cm-selectionMatch, .cm-trailingSpace": {
    backgroundColor: "var(--active-wash)",
  },
  /* The fold marks in their own column: part of the text's frame, not a panel beside it. */
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted)",
    border: "none",
  },
  ".cm-foldGutter .cm-gutterElement": {
    cursor: "pointer",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--selection)",
  },
  ".cm-nonmatchingBracket": {
    backgroundColor: "var(--error-wash)",
  },
  /* The search panel: the app's surfaces and controls, not the default grey. Its matches take
     the same wash as an echo of a selection, and the current one the selection itself. */
  ".cm-panels": {
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    borderTop: "1px solid var(--line)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--active-wash)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--selection)",
  },
});
