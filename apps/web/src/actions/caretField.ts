/** Which field of an action file a line belongs to, for the editor's documentation panel to
 * follow the caret with. Pure: the editor's text and the caret's 1-based line go in, the
 * frontmatter key — or `body`, below the frontmatter — comes out.
 *
 * The regions are `@corvi/actions/model`'s: a file opens with `---`, carries its fields until
 * the next `---`, and the body is everything below that. Inside the frontmatter a key line
 * (`kind:`) names the field, and the lines under it — a phase list, a wrapped value — belong to
 * it. A blank line or a comment belongs to no field. An undocumented key reports itself and
 * nothing lights: the panel matches what comes out against the fields it has entries for. */

const MARKER = "---";
const KEY = /^([A-Za-z][A-Za-z0-9_-]*):/;
const EMPTY = /^\s*(#.*)?$/;

export const fieldAtLine = (text: string, line: number): string | undefined => {
  const lines = text.split("\n").map((row) => row.replace(/\r$/, ""));
  if (line < 1 || line > lines.length || lines[0] !== MARKER) return undefined;
  // The frontmatter ends at the first `---` after it opened; without one, the file is still
  // being written and every line below the marker is a field line.
  const closing = lines.findIndex((row, index) => index > 0 && row === MARKER);
  if (closing !== -1) {
    if (line === closing + 1) return undefined; // the closing marker itself
    if (line > closing + 1) return "body"; // below it
  }
  const row = lines[line - 1] ?? "";
  if (EMPTY.test(row)) return undefined;
  const own = KEY.exec(row);
  if (own !== null) return own[1];
  // A continuation line: the nearest key above it, walking up past other continuations.
  for (let index = line - 2; index >= 1; index--) {
    const above = lines[index] ?? "";
    if (EMPTY.test(above)) continue;
    const key = KEY.exec(above);
    if (key !== null) return key[1];
  }
  return undefined;
};
