import { readdir, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { Effect } from "effect";
import { config } from "./config.ts";
import { remoteDefaultBranch } from "../../core/integrations/git.ts";
import { BadRequestError } from "../../core/platform/effect/errors.ts";
import { fs, shSoft } from "../../core/platform/effect/support.ts";

export type Entry = {
  /** Path relative to the repos root, e.g. "personal/my-project". */
  path: string;
  name: string;
  /** A git repository, so it can be selected as part of a change. */
  isRepo: boolean;
};

/** Resolve a browser path inside the repos root, rejecting anything that escapes it.
 * Purely synchronous, so no Effect wrapper: it throws the typed taxonomy (BadRequestError),
 * the way applyPatch in src/change/model.ts does. */
export function resolveInRoot(relative: string): string {
  const full = join(config.reposRoot, normalize(relative));
  if (full !== config.reposRoot && !full.startsWith(config.reposRoot + sep)) {
    throw new BadRequestError({ message: `path outside repos root: ${relative}` });
  }
  return full;
}

/** Configured starting directory as a path relative to the root, empty when it is the root or
 * lies outside it. */
// Pure and synchronous: nothing for an Effect to wrap.
export function startPath(): string {
  const start = config.reposStart;
  if (start === config.reposRoot || !start.startsWith(config.reposRoot + sep)) return "";
  return start.slice(config.reposRoot.length + 1);
}

/** Directories directly under `relative`, hidden ones omitted. `undefined` means "wherever the
 * browser should open"; an explicit "" is the root, so going up still works. */
export const browse = (
  relative: string = startPath(),
): Effect.Effect<{ root: string; path: string; entries: Entry[] }> =>
  Effect.gen(function* () {
    const dir = resolveInRoot(relative);
    const found = yield* fs(() => readdir(dir, { withFileTypes: true }));
    const entries = yield* Effect.forEach(
      found.filter((e) => e.isDirectory() && !e.name.startsWith(".")),
      (e) =>
        Effect.gen(function* () {
          const path = relative ? `${relative}/${e.name}` : e.name;
          // A clone has .git as a directory, a worktree as a file: stat covers both, Bun.file does not.
          const isRepo = yield* fs(() =>
            stat(join(dir, e.name, ".git")).then(
              () => true,
              () => false,
            ),
          );
          return { path, name: e.name, isRepo };
        }),
      // Unbounded concurrency is deliberate: these per-entry stats are independent.
      { concurrency: "unbounded" },
    );
    return {
      root: config.reposRoot,
      path: relative,
      entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
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

export const absolutePath = (relative: string): string => resolveInRoot(relative);

