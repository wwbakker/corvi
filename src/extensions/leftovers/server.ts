import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { root, changeDir } from "../../change/server/index.ts";
import { Shell, Workspace } from "../../integrations/api/capabilities.ts";
import type { Result } from "../../capabilities/shell.ts";
import { BadRequestError } from "../../capabilities/effect/errors.ts";
import { fs } from "../../capabilities/effect/support.ts";
import { file } from "../../capabilities/files.ts";
import type { Leftover } from "./shared.ts";

/**
 * Directories in the changes root that no longer belong to a change, and their removal.
 *
 * Reads leftover directories through change-store helpers and runs subprocesses through Shell.
 * The removal checks protect directories that still contain a change record.
 */

/** errors.ts's Data.TaggedError leaves `message` empty; the taxonomy requires each error to
 * carry a human-readable message, so set it explicitly (as sh.ts's failCli does). */
const badRequest = (message: string): BadRequestError => {
  const error = new BadRequestError({ message });
  (error as { message: string }).message = message;
  return error;
};

/** The Result-branching contract: the one failure `Shell` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result, never, Shell | Workspace> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    return yield* shell.run(cmd, { cwd }).pipe(
      Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    );
  });

/**
 * What a directory is to git: a worktree has `.git` as a file pointing back at its repository, a
 * clone has it as a directory. Deleting either loses something a build artifact does not.
 */
const gitKind = (path: string): Effect.Effect<"worktree" | "repository" | undefined> =>
  Effect.map(
    // No `.git` there is the usual case, not an error: what `.catch(() => null)` did.
    Effect.promise(() => stat(join(path, ".git")).catch(() => null)),
    (found) => (found ? (found.isDirectory() ? "repository" : "worktree") : undefined),
  );

/** The repository a worktree belongs to, read from the `gitdir:` line git leaves in it. */
const repositoryOf = (worktree: string): Effect.Effect<string | undefined> =>
  Effect.map(
    Effect.promise(() => file(join(worktree, ".git")).text().catch(() => "")),
    (text) => {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      // .../<repo>/.git/worktrees/<name> — the repository is what comes before /.git/.
      return gitdir?.split("/.git/worktrees/")[0];
    },
  );

/** Whether this directory is still a change's own: those are never leftovers. */
const isChange = (name: string): Effect.Effect<boolean> =>
  Effect.promise(() => file(join(changeDir(name), "change.json")).exists());

export const listLeftovers: Effect.Effect<Leftover[], never, Shell | Workspace> = Effect.gen(
  function* () {
    const names = yield* Effect.promise(() => readdir(root(), { withFileTypes: true }).catch(() => []));
    const candidates = names.filter((e) => e.isDirectory());
    const found = yield* Effect.forEach(
      candidates,
      (entry): Effect.Effect<Leftover | undefined, never, Shell | Workspace> =>
        Effect.gen(function* () {
          if (yield* isChange(entry.name)) return undefined;
          const path = changeDir(entry.name);
          const [entries, du] = yield* Effect.all([
            Effect.promise(() => readdir(path, { withFileTypes: true }).catch(() => [])),
            shResult(["du", "-sk", path]),
          ]);
          const inner = yield* Effect.forEach(
            entries,
            (e): Effect.Effect<Leftover["entries"][number]> =>
              e.isDirectory()
                ? Effect.map(gitKind(join(path, e.name)), (git) => ({ name: e.name, directory: true, git }))
                : Effect.succeed({ name: e.name, directory: false, git: undefined }),
            { concurrency: "unbounded" },
          );
          return {
            name: entry.name,
            path,
            entries: inner,
            kilobytes: Number(du.stdout.split(/\s+/)[0] ?? 0),
          };
        }),
      { concurrency: "unbounded" },
    );
    return found.filter((l): l is Leftover => l !== undefined).sort((a, b) => b.kilobytes - a.kilobytes);
  },
);

/**
 * Delete one leftover directory. Refuses anything that is still a change, and anything outside
 * the changes root: this removes a directory tree, so it checks what it is pointed at. The
 * Effect fails with a `BadRequestError` carrying a human-readable message.
 */
export const removeLeftover = (
  name: string,
): Effect.Effect<void, BadRequestError, Shell | Workspace> =>
  Effect.gen(function* () {
    const path = changeDir(name);
    if (name !== "" && join(root(), name) !== path) {
      return yield* badRequest(`not a change directory: ${name}`);
    }
    if (name.includes("/") || name.startsWith(".")) {
      return yield* badRequest(`not a change directory: ${name}`);
    }
    if (yield* isChange(name)) {
      return yield* badRequest(`${name} is an active change, not a leftover`);
    }
    // Already gone: a falsy stat means there is nothing left to remove.
    if (!(yield* Effect.promise(() => stat(path).catch(() => null)))) return;

    // Worktrees inside it stay registered with their repositories after the directory goes, and
    // git then refuses to reuse the name until someone prunes. Ask them first, tidy up after.
    const entries = yield* Effect.promise(() =>
      readdir(path, { withFileTypes: true }).catch(() => []),
    );
    const repositories = yield* Effect.forEach(
      entries.filter((e) => e.isDirectory()),
      (e) =>
        Effect.gen(function* () {
          return (yield* gitKind(join(path, e.name))) === "worktree"
            ? yield* repositoryOf(join(path, e.name))
            : undefined;
        }),
      { concurrency: "unbounded" },
    );
    // Filesystem failures are defects, not domain errors — the directories we remove are ours,
    // so the raw rejection escapes as a defect.
    yield* fs(() => rm(path, { recursive: true, force: true }).then(() => undefined));
    for (const repository of new Set(repositories.filter(Boolean) as string[])) {
      yield* shResult(["git", "worktree", "prune"], repository);
    }
  });
