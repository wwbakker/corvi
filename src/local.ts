import { basename } from "node:path";
import { Effect } from "effect";
import type { Change, FileChange } from "./types.ts";
import { checkoutFor, baseFor } from "./integrations/git.ts";
import { sh, type Result } from "./sh.ts";
import { BadRequestError, CliError } from "./effect/errors.ts";

export type { FileChange };

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

/** What the review tab knows about one repository: what is uncommitted, and what is committed
 * but not pushed. */
export type LocalStatus = {
  repo: string;
  name: string;
  worktree?: string;
  files: FileChange[];
  /** Commits the remote has not got: ahead of the upstream, or everything since the base branch
   * when the branch was never pushed. */
  unpushed: number;
  /** Whether the branch has an upstream at all, which decides how it is pushed. */
  tracked: boolean;
  error?: string;
};

/** `# branch.ab +2 -0` from porcelain v2's header: how far ahead of its upstream this branch is.
 * Absent when there is no upstream, which is a different question, answered below. */
export const aheadIn = (stdout: string): number | undefined => {
  const found = /^# branch\.ab \+(\d+) /m.exec(stdout.replaceAll("\0", "\n"));
  return found ? Number(found[1]) : undefined;
};

export const trackedIn = (stdout: string): boolean =>
  /^# branch\.upstream \S/m.test(stdout.replaceAll("\0", "\n"));

/** The Result-branching contract: the one failure `sh` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[], cwd?: string): Effect.Effect<Result> =>
  sh(cmd, cwd).pipe(
    Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
  );

const worktreeOf = (change: Change, repo: string): Effect.Effect<string | undefined> =>
  checkoutFor(change, repo);

const baseOf = (change: Change, repo: string): Effect.Effect<string | undefined> =>
  baseFor(change, repo);

/** Commits made since the branch left its base, for a branch with no upstream to compare to. */
const sinceBase = (
  change: Change,
  repo: string,
  worktree: string,
): Effect.Effect<number, unknown> =>
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
): Effect.Effect<LocalStatus, unknown> =>
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
): Effect.Effect<string, BadRequestError | CliError | unknown> =>
  Effect.gen(function* () {
    const worktree = yield* worktreeOf(change, repo);
    if (!worktree) {
      // 400: a wrong request against this change, not a missing resource (matching the same
      // message's BadRequestError in the integrations).
      const message = `no worktree for ${change.branch} in ${repo}`;
      return yield* Effect.fail(new BadRequestError({ message }));
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
      return yield* Effect.fail(
        new CliError({
          message,
          tool: "git",
          command: command.join(" "),
          stderr: message,
          exitCode: r.code,
        }),
      );
    }
    return r.stdout;
  });
