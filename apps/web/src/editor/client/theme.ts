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
  // A construct's marks — `#`, `**`, `[]()`, the fence lines — not its content: dimmed, and
  // stripped of the content's weight, slant and strike so the punctuation reads as punctuation.
  mark: {
    color: "var(--md-mark)",
    fontWeight: "normal",
    fontStyle: "normal",
    textDecorationLine: "none",
  },
};

/**
 * Which role each syntax tag plays. The tags are the ones `@lezer/markdown` puts on its tree —
 * a mark carries both its own `processingInstruction` tag and the tag of the construct it opens
 * (the `#` of a heading is `heading1` *and* `processingInstruction`), so the mark entries come
 * last in the highlight style below: on a combined tag, the later definition wins, and the mark
 * must win for the punctuation to stay dim and unstyled. Unlisted tags — ordinary paragraph
 * text above all — wear the editor's default color.
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
  // The marks, last: see above.
  [tags.processingInstruction, "mark"],
  [tags.escape, "mark"],
  [tags.contentSeparator, "mark"],
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
});
