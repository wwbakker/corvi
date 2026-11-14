import { expect, test } from "bun:test"

import { parseBranchStatus, parseStatusEntries } from "../src/node/status.ts"

test("a rename carries where it came from, and a path with spaces survives", () => {
  // The new name alone loses the point; the path is the last field and everything before it is
  // counted, so a space in it is the path's own.
  const v2 =
    "2 R. N... 100644 100644 100644 aaa bbb R100 new name\0old name\0" +
    "1 .M N... 100644 100644 100644 aaa bbb other\0"
  expect(parseStatusEntries(v2)).toEqual([
    { path: "new name", index: "R", worktree: ".", staged: true, unstaged: false, untracked: false, from: "old name" },
    { path: "other", index: ".", worktree: "M", staged: false, unstaged: true, untracked: false },
  ])
})

test("the branch header says whether there is an upstream, and how far ahead of it HEAD is", () => {
  expect(
    parseBranchStatus("# branch.oid abc\0# branch.head feature\0# branch.upstream origin/feature\0# branch.ab +2 -0\0"),
  ).toEqual({ entries: [], upstream: true, ahead: 2 })
  // Never pushed: no upstream, and "ahead" says nothing rather than zero.
  expect(parseBranchStatus("# branch.oid abc\0# branch.head feature\0? new.txt\0")).toEqual({
    entries: [{ path: "new.txt", index: "?", worktree: "?", staged: false, unstaged: false, untracked: true }],
    upstream: false,
  })
})
