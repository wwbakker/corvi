import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { root, ARCHIVE, changeDir } from "./changes.ts";
import { shEffect, type Result } from "./sh.ts";
import { BadRequestError } from "./effect/errors.ts";

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

/** errors.ts's Data.TaggedError leaves `message` empty; the taxonomy requires each error to
 * carry the human-readable message the old `throw` had, so set it explicitly (as sh.ts's
 * failCli does). */
const badRequest = (message: string): BadRequestError => {
  const error = new BadRequestError({ message });
  (error as { message: string }).message = message;
  return error;
};

/** The Result shape the old `sh()` facade returned: a timed-out CLI — the one `CliError`
 * `shEffect` can fail with here — is a failed command (exit code 124), not a failure of the
 * operation. Everything downstream branches on `code`, exactly as before. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  shEffect(cmd, cwd).pipe(
    Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
  );

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
    Effect.promise(() => Bun.file(join(worktree, ".git")).text().catch(() => "")),
    (text) => {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      // .../<repo>/.git/worktrees/<name> — the repository is what comes before /.git/.
      return gitdir?.split("/.git/worktrees/")[0];
    },
  );

/** Whether this directory is still a change's own: those are never leftovers. */
const isChange = (name: string): Effect.Effect<boolean> =>
  Effect.promise(() => Bun.file(join(changeDir(name), "change.json")).exists());

export const listLeftoversEffect: Effect.Effect<Leftover[]> = Effect.gen(function* () {
  const names = yield* Effect.promise(() => readdir(root(), { withFileTypes: true }).catch(() => []));
  const candidates = names.filter((e) => e.isDirectory() && e.name !== ARCHIVE);
  const found = yield* Effect.forEach(
    candidates,
    (entry): Effect.Effect<Leftover | undefined> =>
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
});

/** TODO-MIGRATE */
export const listLeftovers = (): Promise<Leftover[]> => Effect.runPromise(listLeftoversEffect);

/**
 * Delete one leftover directory. Refuses anything that is still a change, and anything outside
 * the changes root: this removes a directory tree, so it checks what it is pointed at. Where the
 * old code threw, the Effect fails with a `BadRequestError` carrying the same message.
 */
export const removeLeftoverEffect = (name: string): Effect.Effect<void, BadRequestError> =>
  Effect.gen(function* () {
    const path = changeDir(name);
    if (name !== "" && join(root(), name) !== path) {
      return yield* Effect.fail(badRequest(`not a change directory: ${name}`));
    }
    if (name === ARCHIVE || name.includes("/") || name.startsWith(".")) {
      return yield* Effect.fail(badRequest(`not a change directory: ${name}`));
    }
    if (yield* isChange(name)) {
      return yield* Effect.fail(badRequest(`${name} is an active change, not a leftover`));
    }
    // Already gone: what the old code's falsy `stat` check did.
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
    // and the old code let the raw rejection escape the same way.
    yield* Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }).then(() => undefined),
      catch: (e) => e,
    }).pipe(Effect.orDie);
    for (const repository of new Set(repositories.filter(Boolean) as string[])) {
      yield* shResult(["git", "worktree", "prune"], repository);
    }
  });

/** TODO-MIGRATE */
export const removeLeftover = (name: string): Promise<void> =>
  Effect.runPromise(removeLeftoverEffect(name));
