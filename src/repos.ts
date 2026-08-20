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

/** Configured starting directory as a path relative to the root, empty when it is the root or
 * lies outside it. */
export function startPath(): string {
  const start = config.reposStart;
  if (start === config.reposRoot || !start.startsWith(config.reposRoot + sep)) return "";
  return start.slice(config.reposRoot.length + 1);
}

/** Directories directly under `relative`, hidden ones omitted. `undefined` means "wherever the
 * browser should open"; an explicit "" is the root, so going up still works. */
export async function browse(
  relative: string = startPath(),
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

/** Branches on the remote, newest first, with the remote's default first of all: what a new
 * branch can start from.
 *
 * Fetched first, and pruned: the branch you want to build on is usually the one a colleague
 * pushed this morning, and a stale list is worse than a slow one — you would pick a base that
 * does not exist or is behind. Tags are skipped, nothing here needs them. */
export async function remoteBranches(
  repo: string,
): Promise<{ branches: string[]; default?: string }> {
  const { remoteDefaultBranch } = await import("./integrations/git.ts");
  const { sh } = await import("./sh.ts");
  await sh(["git", "fetch", "--quiet", "--prune", "--no-tags", "origin"], repo);
  const fallback = await remoteDefaultBranch(repo);
  const r = await sh(
    ["git", "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"],
    repo,
  );
  // `refs/remotes/origin` itself is the remote's HEAD symref, which shortens to a bare remote
  // name and is not a branch anyone can start from.
  const found = r.stdout.split("\n").filter((b) => b.includes("/") && !b.endsWith("/HEAD"));
  // The default first: it is what nearly every change starts from.
  const branches = fallback ? [fallback, ...found.filter((b) => b !== fallback)] : found;
  return { branches, default: fallback };
}

export const absolutePath = (relative: string): string => resolveInRoot(relative);
