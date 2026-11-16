/** Which of several Markdown files of the same id wins: the four scopes, most specific first.
 *
 * Repository > workspace > global > built-in. A file of the same id in a more specific scope
 * shadows the rest outright; the same id in two repositories is not a collision at all — both are
 * listed, each qualified by its repository's name, because a checkout's files travel with the
 * checkout. The rule is shared by actions and subagent profiles; the parsing is the caller's.
 */
export type ScopedSource = "repository" | "workspace" | "global" | "builtin";

export type ScopedFileInput = {
  /** The filename without `.md`: the document's id. */
  readonly id: string;
  readonly source: ScopedSource;
  /** The workspace id or repository name the file came from; part of the key. */
  readonly origin?: string;
  /** How the source is shown beside the label ("orders-api"). */
  readonly originLabel?: string;
};

export type ScopedEntry<T, F extends ScopedFileInput = ScopedFileInput> = {
  readonly key: string;
  readonly file: F;
  readonly value: T;
};

export type ScopedSkipped = {
  readonly key: string;
  readonly reasons: readonly string[];
};

export type ScopedDiscovery<T, F extends ScopedFileInput = ScopedFileInput> = {
  readonly entries: readonly ScopedEntry<T, F>[];
  /** Files that did not parse, with their reasons. They never hide the rest. */
  readonly skipped: readonly ScopedSkipped[];
};

/** `repository:orders-api:test`, `workspace:personal:test`, `global:test`, `builtin:brief`. */
export const keyOf = (source: ScopedSource, origin: string | undefined, id: string): string =>
  source === "global" || source === "builtin" ? `${source}:${id}` : `${source}:${origin ?? ""}:${id}`;

/** A parsed file, or the reasons it is not one. */
export type ScopedParse<T> = { readonly value: T } | { readonly reasons: readonly string[] };

const rank: Record<ScopedSource, number> = {
  repository: 3,
  workspace: 2,
  global: 1,
  builtin: 0,
};

/** Parse every file and apply the precedence rules. Order survives: files come in scope order
 * (built-in, global, workspace, repositories) and the caller lists them that way. */
export const mergeScopedFiles = <F extends ScopedFileInput, T>(
  files: readonly F[],
  parse: (file: F) => ScopedParse<T>,
): ScopedDiscovery<T, F> => {
  const parsed: ScopedEntry<T, F>[] = [];
  const skipped: ScopedSkipped[] = [];
  for (const file of files) {
    const key = keyOf(file.source, file.origin, file.id);
    const result = parse(file);
    if ("reasons" in result) {
      skipped.push({ key, reasons: result.reasons });
      continue;
    }
    parsed.push({ key, file, value: result.value });
  }

  const byId = new Map<string, ScopedEntry<T, F>[]>();
  for (const found of parsed) {
    const same = byId.get(found.file.id) ?? [];
    same.push(found);
    byId.set(found.file.id, same);
  }
  const winners = new Set<ScopedEntry<T, F>>();
  for (const same of byId.values()) {
    const repositories = same.filter((found) => found.file.source === "repository");
    if (repositories.length > 0) {
      for (const found of repositories) winners.add(found);
      continue;
    }
    winners.add(
      same.reduce((best, found) => (rank[found.file.source] > rank[best.file.source] ? found : best)),
    );
  }

  return { entries: parsed.filter((found) => winners.has(found)), skipped };
};
