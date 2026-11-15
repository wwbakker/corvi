/** The frontmatter block and the body below it, shared by every Markdown file Corvi reads as a
 * document with settings (actions, subagent profiles).
 *
 * A file without the `---` pair has no settings to read, whatever its body says. The raw
 * frontmatter text comes back too, so a caller can rewrite a body without reprinting what the
 * user wrote above it. Parsing is total: a block that is not YAML is `undefined`, not a throw. */
import { parse as parseYaml } from "yaml";

export type Frontmatter = {
  readonly fields: unknown;
  readonly frontmatter: string;
  readonly body: string;
};

export const splitFrontmatter = (text: string): Frontmatter | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  let fields: unknown;
  try {
    fields = parseYaml(match[1] ?? "");
  } catch {
    return undefined;
  }
  return { fields, frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
};
