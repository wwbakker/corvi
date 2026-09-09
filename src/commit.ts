import { basename } from "node:path";
import { Effect } from "effect";
import type { Change } from "./types.ts";
import { worktreeFor, currentBranch } from "./integrations/git.ts";
import { shEffect, type Result } from "./sh.ts";
import { BadRequestError } from "./effect/errors.ts";

/** Writing to git, for the review tab: committing across the change, and pushing what is
 * committed. Both work repository by repository and report per repository. */

/** One commit per repository, with the same message: a change is one piece of work, and its
 * repositories are an implementation detail of where the code lives. */
export type CommitRequest = { message: string; files: Record<string, string[]> };

export type CommitResult = {
  repo: string;
  name: string;
  ok: boolean;
  /** Short hash of what was committed, or what git said about the push: the confirmation. */
  hash?: string;
  error?: string;
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
 * `shEffect` can fail with here — is a failed command (exit code 124), which each repository
 * reports in its `error` field, exactly as any other non-zero exit did. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  shEffect(cmd, cwd).pipe(
    Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
  );

// TODO-MIGRATE — integrations/git.ts is another worker's task: the Promise facade wrapped in
// Effect.tryPromise until that lands, then swept by the server task with the rest.
const worktreeOf = (change: Change, repo: string): Effect.Effect<string | undefined, unknown> =>
  Effect.tryPromise({ try: () => worktreeFor(change, repo), catch: (e) => e });

/**
 * Commit the chosen files in each repository that has any chosen.
 *
 * Two commands per repository, and both are given the paths explicitly:
 *
 * - `git add -- <paths>` so that untracked files and deletions are recorded, which a plain
 *   commit would not pick up;
 * - `git commit -- <paths>` so that only those paths are committed. Anything else you had
 *   staged stays staged. Committing the whole index because you happened to open this dialog
 *   would be a surprise, and the surprising half would be invisible.
 *
 * A repository that fails does not stop the others: they are separate repositories, and half a
 * change committed is a normal state to be in — the ones that worked say so, the one that did
 * not says why.
 */
export const commitChangeEffect = (
  change: Change,
  request: CommitRequest,
): Effect.Effect<CommitResult[], BadRequestError | unknown> =>
  Effect.gen(function* () {
    const message = request.message.trim();
    if (!message) return yield* Effect.fail(badRequest("a commit needs a message"));

    const chosen = Object.entries(request.files).filter(([, paths]) => paths.length > 0);
    if (chosen.length === 0) return yield* Effect.fail(badRequest("select at least one file to commit"));

    return yield* Effect.forEach(
      chosen,
      ([repo, paths]): Effect.Effect<CommitResult, unknown> =>
        Effect.gen(function* () {
          const name = basename(repo);
          const worktree = yield* worktreeOf(change, repo);
          if (!worktree) return { repo, name, ok: false, error: "no worktree" };

          const added = yield* shResult(["git", "add", "--", ...paths], worktree);
          if (added.code !== 0) {
            return { repo, name, ok: false, error: added.stderr || added.stdout };
          }
          const committed = yield* shResult(["git", "commit", "-m", message, "--", ...paths], worktree);
          if (committed.code !== 0) {
            return { repo, name, ok: false, error: committed.stderr || committed.stdout };
          }
          const hash = yield* shResult(["git", "rev-parse", "--short", "HEAD"], worktree);
          return { repo, name, ok: true, hash: hash.stdout || undefined };
        }),
      { concurrency: "unbounded" },
    );
  });

/** TODO-MIGRATE */
export const commitChange = (change: Change, request: CommitRequest): Promise<CommitResult[]> =>
  Effect.runPromise(commitChangeEffect(change, request));

/**
 * Push what is committed, in every repository that has something the remote has not.
 *
 * `-u` when the branch has no upstream yet, which is every branch a change makes: the first push
 * is also where the branch comes into existence on the remote, and without it `git push` refuses
 * and tells you the command you should have typed.
 *
 * Like committing, a repository that fails does not stop the others.
 */
export const pushChangeEffect = (
  change: Change,
  repos: string[],
): Effect.Effect<CommitResult[], BadRequestError | unknown> =>
  Effect.gen(function* () {
    if (repos.length === 0) return yield* Effect.fail(badRequest("nothing to push"));
    return yield* Effect.forEach(
      repos,
      (repo): Effect.Effect<CommitResult, unknown> =>
        Effect.gen(function* () {
          const name = basename(repo);
          const worktree = yield* worktreeOf(change, repo);
          if (!worktree) return { repo, name, ok: false, error: "no worktree" };

          // TODO-MIGRATE — integrations facade behind Effect.tryPromise until swept.
          const branch = yield* Effect.tryPromise({
            try: () => currentBranch(worktree),
            catch: (e) => e,
          });
          const pushed = yield* shResult(
            ["git", "push", "-u", "origin", branch || change.branch],
            worktree,
          );
          if (pushed.code !== 0) return { repo, name, ok: false, error: pushed.stderr || pushed.stdout };
          // git says what it did on stderr, and the last line of it is the useful half.
          return { repo, name, ok: true, hash: (pushed.stderr || pushed.stdout).split("\n").pop() };
        }),
      { concurrency: "unbounded" },
    );
  });

/** TODO-MIGRATE */
export const pushChange = (change: Change, repos: string[]): Promise<CommitResult[]> =>
  Effect.runPromise(pushChangeEffect(change, repos));
