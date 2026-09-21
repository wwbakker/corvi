import { basename } from "node:path";
import { Effect } from "effect";
import {
  BadRequestError,
  CliError,
} from "../../capabilities/effect/errors.ts";
import { Changes, Shell, Workspace } from "../../integrations/api/capabilities.ts";
import type { Result } from "../../capabilities/shell.ts";
import type { Change } from "../../domain/change.ts";
import type {
  CommitRequest,
  CommitResult,
  FileChange,
  LocalStatus,
} from "./shared.ts";

/**
 * The review extension's server half: what is uncommitted across a change, the diff of one file,
 * and writing to git — committing across the change and pushing what is committed.
 *
 * Everything it needs arrives through the contract: the read-only `Changes` store locates a
 * change, its checkout and its base branch, and `Shell` runs git with the request workspace's
 * environment already applied. It reaches nothing else in core — no change store, no git
 * integration, no route helpers — so the extension is a self-contained git surface on the
 * change-tab contract.
 */

/** The path of a porcelain-v2 entry: everything after `n` space-separated fields, since a path
 * may contain spaces and is always last. */
const pathAfter = (entry: string, n: number): string => {
  let at = 0;
  for (let i = 0; i < n; i++) at = entry.indexOf(" ", at) + 1;
  return entry.slice(at);
};

/**
 * Parse `git status --porcelain=v2 -z`.
 *
 * Version 2 rather than the older format because v1 begins its lines with a space when only the
 * working tree changed (` M file`), and `sh` trims what a CLI prints — which quietly ate the
 * first character of every unstaged path. v2 fields start with a record type, so nothing is
 * lost. NUL-separated because paths may contain anything, including newlines; a rename puts the
 * old path in the next field, which is why this walks the list rather than mapping over it.
 */
export function parseStatus(stdout: string): FileChange[] {
  const files: FileChange[] = [];
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const kind = entry[0];

    if (kind === "?") {
      files.push({
        path: entry.slice(2),
        index: "?",
        worktree: "?",
        staged: false,
        unstaged: false,
        untracked: true,
      });
      continue;
    }
    // 1 changed, 2 renamed or copied, u unmerged; anything else is a header we do not ask for.
    if (!["1", "2", "u"].includes(kind ?? "")) continue;

    const xy = entry.slice(2, 4);
    const index = xy[0] ?? " ";
    const worktree = xy[1] ?? " ";
    // Fields before the path: 8 for a change, 9 for a rename (the score), 10 for a conflict.
    const path = pathAfter(entry, kind === "1" ? 8 : kind === "2" ? 9 : 10);
    files.push({
      path,
      index,
      worktree,
      staged: index !== ".",
      unstaged: worktree !== ".",
      untracked: false,
      // The source path of a rename is a field of its own, not a file of its own.
      from: kind === "2" ? parts[++i] : undefined,
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** `# branch.ab +2 -0` from porcelain v2's header: how far ahead of its upstream this branch is.
 * Absent when there is no upstream, which is a different question, answered below. */
export const aheadIn = (stdout: string): number | undefined => {
  const found = /^# branch\.ab \+(\d+) /m.exec(stdout.replaceAll("\0", "\n"));
  return found ? Number(found[1]) : undefined;
};

export const trackedIn = (stdout: string): boolean =>
  /^# branch\.upstream \S/m.test(stdout.replaceAll("\0", "\n"));

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

/** The change's checkout of `repo`, read through the contract's `Changes` store. */
const worktreeOf = (change: Change, repo: string): Effect.Effect<string | undefined, never, Changes> =>
  Effect.flatMap(Changes, (changes) => changes.checkout(change, repo));

/** The branch this repository's work starts from, through the contract's `Changes` store: what
 * the change chose, or the remote's default. */
const baseOf = (
  change: Change,
  repo: string,
): Effect.Effect<string | undefined, never, Changes> =>
  Effect.flatMap(Changes, (changes) => changes.base(change, repo));

/** Commits made since the branch left its base, for a branch with no upstream to compare to. */
const sinceBase = (
  change: Change,
  repo: string,
  worktree: string,
): Effect.Effect<number, never, Changes | Shell | Workspace> =>
  Effect.gen(function* () {
    const base = yield* baseOf(change, repo);
    if (!base) return 0; // no remote at all: there is nowhere to push, so nothing is unpushed
    const r = yield* shResult(["git", "rev-list", "--count", `${base}..HEAD`], worktree);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  });

/** What is uncommitted in one repository of a change. Live, never cached: this is the file you
 * are editing, and a second-old answer is a wrong one. */
export const localChanges = (
  change: Change,
  repo: string,
): Effect.Effect<LocalStatus, never, Changes | Shell | Workspace> =>
  Effect.gen(function* () {
    const name = basename(repo);
    const worktree = yield* worktreeOf(change, repo);
    if (!worktree) return { repo, name, files: [], unpushed: 0, tracked: false, error: "no worktree" };
    // --branch as well: the header carries the upstream and how far ahead of it we are, which is
    // the other half of "is this work safe anywhere but here".
    const r = yield* shResult(
      ["git", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      worktree,
    );
    if (r.code !== 0) {
      return { repo, name, worktree, files: [], unpushed: 0, tracked: false, error: r.stderr || r.stdout };
    }

    const tracked = trackedIn(r.stdout);
    return {
      repo,
      name,
      worktree,
      files: parseStatus(r.stdout),
      tracked,
      // A branch that was never pushed is not "0 ahead": everything on it since it left the base
      // branch is unpushed, and that is what the button has to offer to push.
      unpushed: tracked ? (aheadIn(r.stdout) ?? 0) : yield* sinceBase(change, repo, worktree),
    };
  });

/**
 * The diff of one file, as `git diff` writes it.
 *
 * Three cases, because git has three: staged asks the index against HEAD, unstaged asks the
 * working tree against the index, and an untracked file is compared against nothing at all —
 * `--no-index` against /dev/null, which is how git itself shows a file it does not know.
 *
 * The Effect fails with the typed taxonomy: no worktree is a `BadRequestError`, a `git diff`
 * that failed for real (exit > 1 — 1 is "there is a difference") is a `CliError`. Both carry a
 * human-readable message.
 */
export const fileDiff = (
  change: Change,
  repo: string,
  file: string,
  staged: boolean,
): Effect.Effect<string, BadRequestError | CliError, Changes | Shell | Workspace> =>
  Effect.gen(function* () {
    const worktree = yield* worktreeOf(change, repo);
    if (!worktree) {
      // 400: a wrong request against this change, not a missing resource (matching the same
      // message's BadRequestError in the integrations).
      const message = `no worktree for ${change.branch} in ${repo}`;
      return yield* new BadRequestError({ message });
    }

    const status = yield* localChanges(change, repo);
    const found = status.files.find((f) => f.path === file);
    const command = found?.untracked
      ? ["git", "diff", "--no-index", "--", "/dev/null", file]
      : ["git", "diff", ...(staged ? ["--cached"] : []), "--", file];

    // `git diff` exits 1 when there is a difference with --no-index, which is the normal case.
    const r = yield* shResult(command, worktree);
    if (r.code > 1) {
      const message = r.stderr || r.stdout || "git diff failed";
      return yield* new CliError({
        message,
        tool: "git",
        command: command.join(" "),
        stderr: message,
        exitCode: r.code,
      });
    }
    return r.stdout;
  });

/** errors.ts's Data.TaggedError leaves `message` empty; the taxonomy requires each error to
 * carry a human-readable message, so set it explicitly (as sh.ts's failCli does). */
const badRequest = (message: string): BadRequestError => {
  const error = new BadRequestError({ message });
  (error as { message: string }).message = message;
  return error;
};

/** The branch a checkout is on, which is what a push without an upstream should name. */
const currentBranch = (
  repo: string,
): Effect.Effect<string, never, Shell | Workspace> =>
  Effect.map(shResult(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo), (r) => r.stdout);

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
export const commitChange = (
  change: Change,
  request: CommitRequest,
): Effect.Effect<CommitResult[], BadRequestError, Changes | Shell | Workspace> =>
  Effect.gen(function* () {
    const message = request.message.trim();
    if (!message) return yield* badRequest("a commit needs a message");

    const chosen = Object.entries(request.files).filter(([, paths]) => paths.length > 0);
    if (chosen.length === 0) return yield* badRequest("select at least one file to commit");

    return yield* Effect.forEach(
      chosen,
      ([repo, paths]): Effect.Effect<CommitResult, never, Changes | Shell | Workspace> =>
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

/**
 * Push what is committed, in every repository that has something the remote has not.
 *
 * `-u` when the branch has no upstream yet, which is every branch a change makes: the first push
 * is also where the branch comes into existence on the remote, and without it `git push` refuses
 * and tells you the command you should have typed.
 *
 * Like committing, a repository that fails does not stop the others.
 */
export const pushChange = (
  change: Change,
  repos: string[],
): Effect.Effect<CommitResult[], BadRequestError, Changes | Shell | Workspace> =>
  Effect.gen(function* () {
    if (repos.length === 0) return yield* badRequest("nothing to push");
    return yield* Effect.forEach(
      repos,
      (repo): Effect.Effect<CommitResult, never, Changes | Shell | Workspace> =>
        Effect.gen(function* () {
          const name = basename(repo);
          const worktree = yield* worktreeOf(change, repo);
          if (!worktree) return { repo, name, ok: false, error: "no worktree" };

          // The branch it is on, which is what a push without an upstream should name.
          const branch = yield* currentBranch(worktree);
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
