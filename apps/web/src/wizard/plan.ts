/**
 * The plan document's rules, as the wizard applies them.
 *
 * The document names the change: its first `#` heading is the title, one-way — the wizard's
 * title field reads it, and a picked issue may write it while it is still what the template put
 * there. The functions here are the whole rule; the draft and the wizard only apply their
 * answers.
 */

/** The heading line's shape: `#` at the start of the line, then whitespace and the title. A
 * bare `#` is an empty heading, `#tag` is not a heading at all (CommonMark), and nothing here
 * looks inside fenced code — the heading that names a change sits at the top of its plan. */
const HEADING = /^#(?:[ \t]+(.*?))?[ \t]*$/;

/** The document's first heading, as positions in the document: where its text starts (past the
 * `#` and the whitespace after it) and ends. `firstHeading` is that text. */
export type HeadingRange = { readonly from: number; readonly to: number };

/** The first heading's text, with its positions — `null` when the document has no heading line. */
export const firstHeadingRange = (text: string): HeadingRange | null => {
  let at = 0;
  for (const line of text.split("\n")) {
    if (HEADING.test(line)) {
      const prefix = /^#[ \t]*/.exec(line)?.[0].length ?? 1;
      const content = line.slice(prefix).replace(/[ \t]+$/, "");
      return { from: at + prefix, to: at + prefix + content.length };
    }
    at += line.length + 1;
  }
  return null;
};

/** The document's first heading — `""` when it has none or it is empty. */
export const firstHeading = (text: string): string => {
  const range = firstHeadingRange(text);
  return range === null ? "" : text.slice(range.from, range.to).trim();
};

/** The document with its heading set: the first heading line rewritten, or `# <heading>` at the
 * top when there is none yet. */
export const setFirstHeading = (text: string, heading: string): string => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => HEADING.test(line));
  if (at < 0) return text.length ? `# ${heading}\n\n${text}` : `# ${heading}\n`;
  lines[at] = heading ? `# ${heading}` : "#";
  return lines.join("\n");
};
