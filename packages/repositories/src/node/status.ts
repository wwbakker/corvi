/** Reading `git status --porcelain=v2 --branch -z`: one entry per path, in git's own vocabulary.
 *
 * Version 2 rather than the older format because v1 begins its lines with a space when only the
 * working tree changed (` M file`), and a runner that trims what a CLI prints quietly eats the
 * first character of every unstaged path. v2 fields start with a record type, so nothing is lost.
 * NUL-separated because paths may contain anything, including newlines; a rename puts the old
 * path in the next field, which is why this walks the list rather than mapping over it. */
import type { BranchStatus, StatusEntry } from "../git.ts"

/** The path of an entry: everything after `fields` space-separated fields, since a path may contain
 * spaces and is always last. */
const pathAfter = (entry: string, fields: number): string => {
  let at = 0
  for (let index = 0; index < fields; index++) at = entry.indexOf(" ", at) + 1
  return entry.slice(at)
}

export const parseStatusEntries = (stdout: string): StatusEntry[] => {
  const entries: StatusEntry[] = []
  const parts = stdout.split("\0")
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index]
    if (!entry) continue
    const kind = entry[0]
    if (kind === "?") {
      entries.push({ path: entry.slice(2), index: "?", worktree: "?", staged: false, unstaged: false, untracked: true })
      continue
    }
    // 1 changed, 2 renamed or copied, u unmerged; anything else is a header.
    if (kind !== "1" && kind !== "2" && kind !== "u") continue
    const xy = entry.slice(2, 4)
    const indexLetter = xy[0] ?? " "
    const worktreeLetter = xy[1] ?? " "
    // Fields before the path: 8 for a change, 9 for a rename (the score), 10 for a conflict.
    const path = pathAfter(entry, kind === "1" ? 8 : kind === "2" ? 9 : 10)
    entries.push({
      path,
      index: indexLetter,
      worktree: worktreeLetter,
      staged: indexLetter !== ".",
      unstaged: worktreeLetter !== ".",
      untracked: false,
      // The source path of a rename is a field of its own, not a file of its own.
      ...(kind === "2" ? { from: parts[++index] ?? "" } : {}),
    })
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

/** The branch half of the header: whether there is an upstream, and how far ahead of it HEAD is
 * (absent without one — a branch that was never pushed is not "0 ahead"). */
export const parseBranchStatus = (stdout: string): BranchStatus => {
  const lines = stdout.replaceAll("\0", "\n")
  const upstream = /^# branch\.upstream \S/m.test(lines)
  const ahead = /^# branch\.ab \+(\d+) /m.exec(lines)
  return {
    entries: parseStatusEntries(stdout),
    upstream,
    ...(ahead ? { ahead: Number(ahead[1]) } : {}),
  }
}
