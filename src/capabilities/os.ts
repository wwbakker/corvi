import { accessSync, constants } from "node:fs";
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { shSoft } from "./effect/support.ts";

// --- Platform facts -----------------------------------------------------------

/**
 * The one place platform ifs live: everything else imports the answer instead of asking
 * `process.platform` itself, so a new platform means editing this file and the callers it
 * names, not grepping the tree for assumptions.
 */

/** macOS, where the native app and `open -a` live. */
export const isMac = process.platform === "darwin";

/** Linux. Anything else (Windows) is unsupported and gets neither platform's favours. */
export const isLinux = process.platform === "linux";

/** Whether a command could actually run: is it on PATH right now? Synchronous, because the only
 * things asking are building a menu and can wait a microsecond; a stale answer would offer an
 * item that cannot work, so it is always asked fresh. */
export const commandAvailable = (command: string): boolean =>
  (process.env.PATH ?? "").split(":").some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/** The platform as one word, for whoever is told only once: the client reads it from
 * /api/workspaces and switches its key hints and shortcuts on it. */
export const platformName = isMac ? "mac" : isLinux ? "linux" : "other";

// --- IDE tooling carried into a new worktree ------------------------------------

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
const ignored = (worktree: string, name: string): Effect.Effect<boolean> =>
  Effect.map(shSoft(["git", "check-ignore", "--quiet", "--", `${name}/`], worktree), (r) => r.code === 0);

/** Whether this looks like text. Bloop and IntelliJ write JSON and XML, but `.idea` also holds
 * the odd icon and `.scala-build` holds class files, and rewriting those would corrupt them. */
const isText = (bytes: Buffer): boolean => !bytes.subarray(0, 8000).includes(0);

/**
 * Copy `names` from `from` into `to`, rewriting `from` to `to` inside them.
 *
 * Returns what was copied. Anything already present in `to` is left as it is — the IDE may have
 * written it since — anything missing from `from` is skipped, which is the normal case (most
 * repositories have one or two of these, not six), and so is anything git does not ignore.
 *
 * An Effect, because the ignore check runs `git` and so reads the request's `Workspace` tag at
 * run time (src/capabilities/shell.ts): the caller (src/vendors/git.ts) runs it inside the request, so the
 * subprocess carries the workspace's environment like every other CLI IWE runs. Filesystem
 * failures stay in the error channel, which the caller logs and keeps going — the worktree is
 * the thing that was asked for, and a change that failed to provision over a copy of `.idea`
 * would be a poor trade.
 */
export const copyTooling = (
  from: string,
  to: string,
  names: string[] = TOOLING,
): Effect.Effect<string[], unknown> =>
  Effect.gen(function* () {
    const copied: string[] = [];
    for (const name of names) {
      const source = join(from, name);
      const target = join(to, name);
      if (!(yield* Effect.tryPromise(() => exists(source)))) continue;
      if (yield* Effect.tryPromise(() => exists(target))) continue;
      if (!(yield* ignored(to, name))) continue;

      yield* Effect.tryPromise(() => cp(source, target, { recursive: true }));
      copied.push(name);

      for (const file of yield* Effect.tryPromise(() => walk(target))) {
        const info = yield* Effect.tryPromise(() => stat(file));
        if (info.size > MAX_REWRITE) continue;
        const bytes = yield* Effect.tryPromise(async () => Buffer.from(await readFile(file)));
        if (!isText(bytes)) continue;
        const text = bytes.toString("utf8");
        if (!text.includes(from)) continue;
        yield* Effect.tryPromise(() => writeFile(file, rewritePaths(text, from, to)));
      }
    }
    return copied;
  });
