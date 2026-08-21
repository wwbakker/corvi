import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { root, ARCHIVE, changeDir } from "./changes.ts";
import { sh } from "./sh.ts";

/**
 * A directory in the changes root that no longer belongs to a change: what a completed change
 * left behind (build output, a shell's history) after `change.json` moved to the archive, or a
 * change that was never finished being created.
 *
 * They are harmless and easy to miss, which is why they are worth showing rather than deleting
 * on your behalf: only you know whether that `target/` is worth keeping.
 */
export type Leftover = {
  name: string;
  path: string;
  /** Top-level entries, so you can see what is in there before removing it. A `git` entry is one
   * you should think twice about: a worktree still registered with its repository, or a whole
   * clone with a history of its own. */
  entries: { name: string; directory: boolean; git?: "worktree" | "repository" }[];
  /** Total size in kilobytes, as `du` reports it. */
  kilobytes: number;
};

/**
 * What a directory is to git: a worktree has `.git` as a file pointing back at its repository, a
 * clone has it as a directory. Deleting either loses something a build artifact does not.
 */
async function gitKind(path: string): Promise<"worktree" | "repository" | undefined> {
  const found = await stat(join(path, ".git")).catch(() => null);
  return found ? (found.isDirectory() ? "repository" : "worktree") : undefined;
}

/** The repository a worktree belongs to, read from the `gitdir:` line git leaves in it. */
async function repositoryOf(worktree: string): Promise<string | undefined> {
  const text = await Bun.file(join(worktree, ".git"))
    .text()
    .catch(() => "");
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  // .../<repo>/.git/worktrees/<name> — the repository is what comes before /.git/.
  return gitdir?.split("/.git/worktrees/")[0];
}

/** Whether this directory is still a change's own: those are never leftovers. */
const isChange = async (name: string): Promise<boolean> =>
  Bun.file(join(changeDir(name), "change.json")).exists();

export async function listLeftovers(): Promise<Leftover[]> {
  const names = await readdir(root(), { withFileTypes: true }).catch(() => []);
  const candidates = names.filter((e) => e.isDirectory() && e.name !== ARCHIVE);
  const found = await Promise.all(
    candidates.map(async (entry): Promise<Leftover | undefined> => {
      if (await isChange(entry.name)) return undefined;
      const path = changeDir(entry.name);
      const [entries, du] = await Promise.all([
        readdir(path, { withFileTypes: true }).catch(() => []),
        sh(["du", "-sk", path]),
      ]);
      return {
        name: entry.name,
        path,
        entries: await Promise.all(
          entries.map(async (e) => ({
            name: e.name,
            directory: e.isDirectory(),
            git: e.isDirectory() ? await gitKind(join(path, e.name)) : undefined,
          })),
        ),
        kilobytes: Number(du.stdout.split(/\s+/)[0] ?? 0),
      };
    }),
  );
  return found.filter((l): l is Leftover => l !== undefined).sort((a, b) => b.kilobytes - a.kilobytes);
}

/**
 * Delete one leftover directory. Refuses anything that is still a change, and anything outside
 * the changes root: this removes a directory tree, so it checks what it is pointed at.
 */
export async function removeLeftover(name: string): Promise<void> {
  const path = changeDir(name);
  if (name !== "" && join(root(), name) !== path) throw new Error(`not a change directory: ${name}`);
  if (name === ARCHIVE || name.includes("/") || name.startsWith(".")) {
    throw new Error(`not a change directory: ${name}`);
  }
  if (await isChange(name)) throw new Error(`${name} is an active change, not a leftover`);
  if (!(await stat(path).catch(() => null))) return; // already gone

  // Worktrees inside it stay registered with their repositories after the directory goes, and
  // git then refuses to reuse the name until someone prunes. Ask them first, tidy up after.
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const repositories = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) =>
        (await gitKind(join(path, e.name))) === "worktree"
          ? repositoryOf(join(path, e.name))
          : undefined,
      ),
  );
  await rm(path, { recursive: true, force: true });
  for (const repository of new Set(repositories.filter(Boolean) as string[])) {
    await sh(["git", "worktree", "prune"], repository);
  }
}
