/**
 * Browser-safe request and response types for local repository review.
 */

/** One file git has something to say about, in the vocabulary git itself uses. */
export type FileChange = {
  path: string;
  /** Status of the index against HEAD, and of the working tree against the index: git's own XY
   * pair, e.g. `M`, `A`, `D`, `R`. A dot means "nothing here" in porcelain v2. */
  index: string;
  worktree: string;
  /** Where it will be listed. A file can be both: staged edits with more edits on top. */
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /** Where a renamed file came from, since the new name alone loses the point. */
  from?: string;
};

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

/** Which file is being looked at: the repository as well, since two repositories may both have
 * a README.md, and the staged half, since that is a different diff of the same path. */
export type Selection = { repo: string; file: string; staged: boolean };

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
