import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sh } from "./sh.ts";

/**
 * IDE and build-tool state, carried into a new worktree.
 *
 * A worktree is a checkout of the same repository, but to IntelliJ it is an unknown directory:
 * without `.idea` it imports the project from scratch, and without `.bsp` it has no build server
 * to import it with. Copying those turns a two-minute reload into opening a project that is
 * already configured.
 *
 * None of this is IWE's state and none of it is in git — it is ignored, per-machine, and written
 * by other programs. We copy it once, at creation, and never look at it again: the IDE owns it
 * from then on, and a worktree that already has some is left alone.
 *
 * "Ignored" is checked rather than assumed. A repository that does not ignore `.idea` gets an
 * untracked directory the moment its worktree is made, which is not a cosmetic problem: the
 * worktree counts as dirty for ever, so it cannot be removed, and the review tab offers our copy
 * of somebody's IDE settings up for committing.
 */

/** What is worth copying: the IDE's project, and the build servers it talks to.
 *
 * Kept to the small ones. `target`, `node_modules` and the like are also missing from a new
 * worktree, but they are outputs — copying them is slower than the build that recreates them,
 * and a stale one is worse than none. */
export const TOOLING = [".idea", ".bsp", ".bloop", ".scala-build", ".metals", ".vscode"];

/** Files this size are caches, not configuration; nothing worth rewriting is a megabyte of
 * text, and reading them all would cost more than the copy did. */
const MAX_REWRITE = 4 * 1024 * 1024;

const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false,
  );

/** Every file under `dir`, depth first. */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * `from` where it is used as a path, not where it is a prefix of a longer name: a repository
 * called `example-api` must not have its paths rewritten inside `example-api-client`, which lives
 * one directory along and appears in the same files.
 */
export function rewritePaths(text: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![\\w.-])`, "g"), to);
}

/**
 * Whether the new worktree ignores this directory.
 *
 * Asked of the worktree rather than of the repository it came from, because they can disagree:
 * a worktree branches from the remote default, which may not carry the `.gitignore` that the
 * checkout you copied from has. The worktree is the one that has to stay clean.
 */
async function ignored(worktree: string, name: string): Promise<boolean> {
  return (await sh(["git", "check-ignore", "--quiet", "--", `${name}/`], worktree)).code === 0;
}

/** Whether this looks like text. Bloop and IntelliJ write JSON and XML, but `.idea` also holds
 * the odd icon and `.scala-build` holds class files, and rewriting those would corrupt them. */
const isText = (bytes: Buffer): boolean => !bytes.subarray(0, 8000).includes(0);

/**
 * Copy `names` from `from` into `to`, rewriting the old path to the new one inside them.
 *
 * Returns what was copied. Anything already present in `to` is left as it is — the IDE may have
 * written it since — anything missing from `from` is skipped, which is the normal case (most
 * repositories have one or two of these, not six), and so is anything git does not ignore.
 */
export async function copyTooling(
  from: string,
  to: string,
  names: string[] = TOOLING,
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of names) {
    const source = join(from, name);
    const target = join(to, name);
    if (!(await exists(source))) continue;
    if (await exists(target)) continue;
    if (!(await ignored(to, name))) continue;

    await cp(source, target, { recursive: true });
    copied.push(name);

    for (const file of await walk(target)) {
      const info = await stat(file);
      if (info.size > MAX_REWRITE) continue;
      const bytes = Buffer.from(await readFile(file));
      if (!isText(bytes)) continue;
      const text = bytes.toString("utf8");
      if (!text.includes(from)) continue;
      await writeFile(file, rewritePaths(text, from, to));
    }
  }
  return copied;
}
