import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { Effect } from "effect";
import { expandTilde } from "./config.ts";
import { runtimeConfig } from "../../capabilities/runtime.ts";
import type { Entry } from "../model.ts";
import { remoteDefaultBranch } from "../../vendors/git.ts";
import { BadRequestError } from "../../capabilities/effect/errors.ts";
import { fs, shSoft } from "../../capabilities/effect/support.ts";

/** An absolute directory as the browser and the settings page speak it: `~` expanded and
 * normalized. There is no root to stay inside — the browser is unbounded — so the only rule left
 * is that a path has to be absolute. A relative one is the caller's mistake and throws the typed
 * taxonomy, the way resolveInRoot did. Purely synchronous, so no Effect wrapper. */
export function resolveDirectory(path: string): string {
  const full = normalize(expandTilde(path));
  if (!isAbsolute(full)) throw new BadRequestError({ message: `not an absolute path: ${path}` });
  return full;
}

/** Directories directly under `dir`. `undefined` means "wherever the browser should open", which
 * is the configured repositories directory. Dot-directories are withheld unless `hidden` asks
 * for them, so the request decides what a listing carries rather than the page filtering it back
 * out — the same shape as everything else here. */
export const browse = (
  dir: string = runtimeConfig().repositoriesDirectory,
  hidden = false,
): Effect.Effect<{ path: string; entries: Entry[] }> =>
  Effect.gen(function* () {
    const full = resolveDirectory(dir);
    const found = yield* fs(() => readdir(full, { withFileTypes: true }));
    const shown = hidden ? found : found.filter((e) => !e.name.startsWith("."));
    const entries = yield* Effect.forEach(
      shown,
      (e) =>
        Effect.gen(function* () {
          const path = join(full, e.name);
          // stat rather than dirent.isDirectory(): a symlinked directory is a directory here.
          // macOS' /etc, /tmp and /var are symlinks, and so is a checkout reached through one;
          // a plain file or a broken link answers false and is not shown.
          const directory = yield* fs(() =>
            stat(path).then(
              (s) => s.isDirectory(),
              () => false,
            ),
          );
          if (!directory) return undefined;
          // A clone has .git as a directory, a worktree as a file: stat covers both.
          const isRepo = yield* fs(() =>
            stat(join(path, ".git")).then(
              () => true,
              () => false,
            ),
          );
          return { path, name: e.name, isRepo } satisfies Entry;
        }),
      // Unbounded concurrency is deliberate: these per-entry stats are independent.
      { concurrency: "unbounded" },
    );
    return {
      path: full,
      entries: entries
        .filter((entry): entry is Entry => entry !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

/** Branches on the remote, newest first, with the remote's default first of all: what a new
 * branch can start from.
 *
 * Fetched first, and pruned: the branch you want to build on is usually the one a colleague
 * pushed this morning, and a stale list is worse than a slow one — you would pick a base that
 * does not exist or is behind. Tags are skipped, nothing here needs them. */
export const remoteBranches = (
  repo: string,
): Effect.Effect<{ branches: string[]; default?: string }> =>
  Effect.gen(function* () {
    yield* shSoft(["git", "fetch", "--quiet", "--prune", "--no-tags", "origin"], repo);
    const fallback = yield* remoteDefaultBranch(repo);
    const r = yield* shSoft(
      ["git", "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"],
      repo,
    );
    // `refs/remotes/origin` itself is the remote's HEAD symref, which shortens to a bare remote
    // name and is not a branch anyone can start from.
    const found = r.stdout.split("\n").filter((b) => b.includes("/") && !b.endsWith("/HEAD"));
    // The default first: it is what nearly every change starts from.
    const branches = fallback ? [fallback, ...found.filter((b) => b !== fallback)] : found;
    return { branches, default: fallback };
  });
