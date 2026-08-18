import { readdir, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { config } from "./config.ts";

export type Entry = {
  /** Path relative to the repos root, e.g. "personal/my-project". */
  path: string;
  name: string;
  /** A git repository, so it can be selected as part of a change. */
  isRepo: boolean;
};

/** Resolve a browser path inside the repos root, rejecting anything that escapes it. */
export function resolveInRoot(relative: string): string {
  const full = join(config.reposRoot, normalize(relative));
  if (full !== config.reposRoot && !full.startsWith(config.reposRoot + sep)) {
    throw new Error(`path outside repos root: ${relative}`);
  }
  return full;
}

/** Directories directly under `relative`, hidden ones omitted. */
export async function browse(
  relative = "",
): Promise<{ root: string; path: string; entries: Entry[] }> {
  const dir = resolveInRoot(relative);
  const found = await readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    found
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map(async (e): Promise<Entry> => {
        const path = relative ? `${relative}/${e.name}` : e.name;
        // A clone has .git as a directory, a worktree as a file: stat covers both, Bun.file does not.
        const isRepo = await stat(join(dir, e.name, ".git")).then(
          () => true,
          () => false,
        );
        return { path, name: e.name, isRepo };
      }),
  );
  return {
    root: config.reposRoot,
    path: relative,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const absolutePath = (relative: string): string => resolveInRoot(relative);
