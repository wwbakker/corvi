import { basename } from "node:path";
import type { Change, FileChange } from "./types.ts";
import { worktreeFor } from "./integrations/git.ts";
import { sh } from "./sh.ts";

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
      // The old path is a field of its own, not a file of its own.
      from: kind === "2" ? parts[++i] : undefined,
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** What is uncommitted in one repository of a change. Live, never cached: this is the file you
 * are editing, and a second-old answer is a wrong one. */
export async function localChanges(
  change: Change,
  repo: string,
): Promise<{ repo: string; name: string; worktree?: string; files: FileChange[]; error?: string }> {
  const name = basename(repo);
  const worktree = await worktreeFor(change, repo);
  if (!worktree) return { repo, name, files: [], error: "no worktree" };
  const r = await sh(
    ["git", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
    worktree,
  );
  if (r.code !== 0) return { repo, name, worktree, files: [], error: r.stderr || r.stdout };
  return { repo, name, worktree, files: parseStatus(r.stdout) };
}

/**
 * The diff of one file, as `git diff` writes it.
 *
 * Three cases, because git has three: staged asks the index against HEAD, unstaged asks the
 * working tree against the index, and an untracked file is compared against nothing at all —
 * `--no-index` against /dev/null, which is how git itself shows a file it does not know.
 */
export async function fileDiff(
  change: Change,
  repo: string,
  file: string,
  staged: boolean,
): Promise<string> {
  const worktree = await worktreeFor(change, repo);
  if (!worktree) throw new Error(`no worktree for ${change.branch} in ${repo}`);

  const status = await localChanges(change, repo);
  const found = status.files.find((f) => f.path === file);
  const command = found?.untracked
    ? ["git", "diff", "--no-index", "--", "/dev/null", file]
    : ["git", "diff", ...(staged ? ["--cached"] : []), "--", file];

  // `git diff` exits 1 when there is a difference with --no-index, which is the normal case.
  const r = await sh(command, worktree);
  if (r.code > 1) throw new Error(r.stderr || r.stdout || "git diff failed");
  return r.stdout;
}
