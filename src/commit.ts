import { basename } from "node:path";
import type { Change } from "./types.ts";
import { worktreeFor, currentBranch } from "./integrations/git.ts";
import { sh } from "./sh.ts";

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
export async function commitChange(
  change: Change,
  request: CommitRequest,
): Promise<CommitResult[]> {
  const message = request.message.trim();
  if (!message) throw new Error("a commit needs a message");

  const chosen = Object.entries(request.files).filter(([, paths]) => paths.length > 0);
  if (chosen.length === 0) throw new Error("select at least one file to commit");

  return Promise.all(
    chosen.map(async ([repo, paths]): Promise<CommitResult> => {
      const name = basename(repo);
      const worktree = await worktreeFor(change, repo);
      if (!worktree) return { repo, name, ok: false, error: "no worktree" };

      const added = await sh(["git", "add", "--", ...paths], worktree);
      if (added.code !== 0) {
        return { repo, name, ok: false, error: added.stderr || added.stdout };
      }
      const committed = await sh(["git", "commit", "-m", message, "--", ...paths], worktree);
      if (committed.code !== 0) {
        return { repo, name, ok: false, error: committed.stderr || committed.stdout };
      }
      const hash = await sh(["git", "rev-parse", "--short", "HEAD"], worktree);
      return { repo, name, ok: true, hash: hash.stdout || undefined };
    }),
  );
}

/**
 * Push what is committed, in every repository that has something the remote has not.
 *
 * `-u` when the branch has no upstream yet, which is every branch a change makes: the first push
 * is also where the branch comes into existence on the remote, and without it `git push` refuses
 * and tells you the command you should have typed.
 *
 * Like committing, a repository that fails does not stop the others.
 */
export async function pushChange(change: Change, repos: string[]): Promise<CommitResult[]> {
  if (repos.length === 0) throw new Error("nothing to push");
  return Promise.all(
    repos.map(async (repo): Promise<CommitResult> => {
      const name = basename(repo);
      const worktree = await worktreeFor(change, repo);
      if (!worktree) return { repo, name, ok: false, error: "no worktree" };

      const branch = await currentBranch(worktree);
      const pushed = await sh(["git", "push", "-u", "origin", branch || change.branch], worktree);
      if (pushed.code !== 0) return { repo, name, ok: false, error: pushed.stderr || pushed.stdout };
      // git says what it did on stderr, and the last line of it is the useful half.
      return { repo, name, ok: true, hash: (pushed.stderr || pushed.stdout).split("\n").pop() };
    }),
  );
}
