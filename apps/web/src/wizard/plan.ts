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

/** The document's first heading — `""` when it has none or it is empty. */
export const firstHeading = (text: string): string => {
  for (const line of text.split("\n")) {
    const found = HEADING.exec(line);
    if (found) return (found[1] ?? "").trim();
  }
  return "";
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
