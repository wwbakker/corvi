import { basename } from "node:path";
import { Effect } from "effect";
import { BadRequestError, CliError } from "@corvi/contracts/errors";
import { AbsolutePath } from "@corvi/contracts/paths";
import { Repositories, type CheckoutError, type NotARepository, type StatusEntry } from "@corvi/repositories";
import { Changes } from "../api/capabilities.ts";
import type { Change } from "@corvi/changes/record";
import type {
  CommitRequest,
  CommitResult,
  FileChange,
  LocalStatus,
} from "@corvi/contracts/integrations/review";
import { repositoriesOverShell } from "../../change/lifecycle-layer.ts";

/**
 * The review extension's server half: what is uncommitted across a change, the diff of one file,
 * and writing to git — committing across the change and pushing what is committed.
 *
 * The git work is the repositories capability's (`@corvi/repositories`), the same one checkouts,
 * completion and shelving use, run through the request's Shell so its workspace's environment
 * applies. The read-only `Changes` store says where a change's checkout of a repository is and
 * what its base branch is. This module only decides what to ask and turns the answers into the
 * tab's per-repository shapes.
 */

/** Run against the repositories capability, over the request's Shell. */
const withRepositories = <A, E>(
  work: (repositories: Repositories["Service"]) => Effect.Effect<A, E, Changes>,
): Effect.Effect<A, E, Changes> =>
  Effect.gen(function* () {
    return yield* work(yield* Repositories);
  }).pipe(Effect.provide(repositoriesOverShell));

/** What a capability failure says: git's own words, or the checkout that is not one. */
const messageOf = (error: NotARepository | CheckoutError): string =>
  error._tag === "NotARepository" ? `${error.directory} is not a repository` : error.message;

/** The change's checkout of `repo`, read through the contract's `Changes` store. */
const worktreeOf = (change: Change, repo: string): Effect.Effect<string | undefined, never, Changes> =>
  Effect.flatMap(Changes, (changes) => changes.checkout(change, repo));

/** The branch this repository's work starts from, through the contract's `Changes` store: what
 * the change chose, or the remote's default. */
const baseOf = (change: Change, repo: string): Effect.Effect<string | undefined, never, Changes> =>
  Effect.flatMap(Changes, (changes) => changes.base(change, repo));

const fileChangeOf = (entry: StatusEntry): FileChange => ({
  path: entry.path,
  index: entry.index,
  worktree: entry.worktree,
  staged: entry.staged,
  unstaged: entry.unstaged,
  untracked: entry.untracked,
  from: entry.from,
});

/** What is uncommitted in one repository of a change. Live, never cached: this is the file you
 * are editing, and a second-old answer is a wrong one. */
export const localChanges = (change: Change, repo: string): Effect.Effect<LocalStatus, never, Changes> =>
  withRepositories((repositories) =>
    Effect.gen(function* () {
      const name = basename(repo);
      const worktree = yield* worktreeOf(change, repo);
      if (!worktree) return { repo, name, files: [], unpushed: 0, tracked: false, error: "no worktree" };
      const directory = AbsolutePath.make(worktree);
      const read = yield* repositories.inspectLocalChanges(directory).pipe(Effect.result);
      if (read._tag === "Failure")
        return { repo, name, worktree, files: [], unpushed: 0, tracked: false, error: messageOf(read.failure) };
      const local = read.success;
      // A branch that was never pushed is not "0 ahead": everything on it since it left the base
      // branch is unpushed, and that is what the button has to offer to push. Without a base —
      // no remote at all — there is nowhere to push, so nothing is unpushed.
      const sinceBase = (): Effect.Effect<number, never, Changes> =>
        Effect.gen(function* () {
          const base = yield* baseOf(change, repo);
          if (!base) return 0;
          return yield* repositories
            .countCommitsSince({ directory, from: base })
            .pipe(Effect.orElseSucceed(() => 0));
        });
      return {
        repo,
        name,
        worktree,
        files: local.files.map(fileChangeOf),
        tracked: local.upstream,
        unpushed: local.upstream ? (local.ahead ?? 0) : yield* sinceBase(),
      };
    }),
  );

/**
 * The diff of one file, as `git diff` writes it: staged asks the index against HEAD, unstaged the
 * working tree against the index, and an untracked file is compared against nothing.
 *
 * No worktree is a `BadRequestError`; a `git diff` that failed for real is a `CliError` carrying
 * git's words.
 */
export const fileDiff = (
  change: Change,
  repo: string,
  file: string,
  staged: boolean,
): Effect.Effect<string, BadRequestError | CliError, Changes> =>
  withRepositories((repositories) =>
    Effect.gen(function* () {
      const worktree = yield* worktreeOf(change, repo);
      // 400: a wrong request against this change, not a missing resource.
      if (!worktree) return yield* new BadRequestError({ message: `no worktree for ${change.branch} in ${repo}` });
      return yield* repositories.diffFile({ directory: AbsolutePath.make(worktree), path: file, staged }).pipe(
        Effect.mapError((error) => {
          const message = messageOf(error);
          // The capability reports git's words, not its exit code.
          return new CliError({ message, tool: "git", command: `git diff -- ${file}`, stderr: message, exitCode: -1 });
        }),
      );
    }),
  );

/** A refusal of the taxonomy's 400. */
const badRequest = (message: string): BadRequestError => new BadRequestError({ message });

/**
 * Commit the chosen files in each repository that has any chosen: exactly those paths, so
 * anything else you had staged stays staged — committing the whole index because you happened to
 * open this dialog would be a surprise, and the surprising half would be invisible.
 *
 * A repository that fails does not stop the others: they are separate repositories, and half a
 * change committed is a normal state to be in — the ones that worked say so, the one that did
 * not says why.
 */
export const commitChange = (
  change: Change,
  request: CommitRequest,
): Effect.Effect<CommitResult[], BadRequestError, Changes> =>
  Effect.gen(function* () {
    const message = request.message.trim();
    if (!message) return yield* badRequest("a commit needs a message");
    const chosen = Object.entries(request.files).filter(([, paths]) => paths.length > 0);
    if (chosen.length === 0) return yield* badRequest("select at least one file to commit");

    return yield* withRepositories((repositories) =>
      Effect.forEach(
        chosen,
        ([repo, paths]): Effect.Effect<CommitResult, never, Changes> =>
          Effect.gen(function* () {
            const name = basename(repo);
            const worktree = yield* worktreeOf(change, repo);
            if (!worktree) return { repo, name, ok: false, error: "no worktree" };
            const committed = yield* repositories
              .commitPaths({ directory: AbsolutePath.make(worktree), message, paths })
              .pipe(Effect.result);
            return committed._tag === "Success"
              ? { repo, name, ok: true, hash: committed.success.hash }
              : { repo, name, ok: false, error: messageOf(committed.failure) };
          }),
        { concurrency: "unbounded" },
      ),
    );
  });

/**
 * Push what is committed, in every repository that has something the remote has not. The first
 * push is also where a change's branch comes into existence on the remote, so it sets the
 * upstream. Like committing, a repository that fails does not stop the others.
 */
export const pushChange = (
  change: Change,
  repos: string[],
): Effect.Effect<CommitResult[], BadRequestError, Changes> =>
  Effect.gen(function* () {
    if (repos.length === 0) return yield* badRequest("nothing to push");
    return yield* withRepositories((repositories) =>
      Effect.forEach(
        repos,
        (repo): Effect.Effect<CommitResult, never, Changes> =>
          Effect.gen(function* () {
            const name = basename(repo);
            const worktree = yield* worktreeOf(change, repo);
            if (!worktree) return { repo, name, ok: false, error: "no worktree" };
            const pushed = yield* repositories
              .pushBranch({ directory: AbsolutePath.make(worktree), fallbackBranch: change.branch })
              .pipe(Effect.result);
            return pushed._tag === "Success"
              ? { repo, name, ok: true, hash: pushed.success.summary }
              : { repo, name, ok: false, error: messageOf(pushed.failure) };
          }),
        { concurrency: "unbounded" },
      ),
    );
  });
