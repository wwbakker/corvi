/** Where a change stands, as you see it. Kept by hand rather than derived: the tools disagree
 * often enough (a merged PR with the ticket still open, review happening in a call) that your
 * own answer is the useful one. Completing a change sets it to "Completed".
 *
 * The order is the order the work moves through, which is the order the select offers.
 * "Blocked" is waiting on something you cannot do yourself — an answer, a decision, another
 * change — as opposed to "Awaiting Review", which is waiting on a named person to look at
 * finished work. Everything that is not "Completed" counts as active on the overview. */
export const CHANGE_STATES = ["In Progress", "Blocked", "Awaiting Review", "Completed"] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

/** A unit of work spanning one or more repositories, plus the tickets/PRs/builds around it. */
export type Change = {
  /** Directory name under the changes root; also the default branch name. */
  id: string;
  /** Branch used in every repo worktree of this change. */
  branch: string;
  /** Absolute paths to the source repositories this change touches. Editable later. */
  repos: string[];
  /** Branch each repository's work started from, keyed by repository path, e.g.
   * `origin/main` or another change's branch when this work is stacked on it. Absent means the
   * remote's default branch, which is what every change made before this used. */
  base?: Record<string, string>;
  /** The subset of `repos` worked on in place: the repository's own checkout is switched to the
   * branch and linked from the change directory, instead of getting a worktree. */
  direct?: string[];
  /** Optional Jira issue key, e.g. PROJ-123. */
  jira?: string;
  /** The ticket's summary as of the last time Jira was asked. A label, kept so the overview can
   * name a change without a CLI call per row, and so an archived change still reads as English
   * years later. Never a source of truth: `jira` is. */
  title?: string;
  /** Absent on changes made before this existed; treated as "In Progress". */
  state?: ChangeState;
  createdAt: string;
  /** Set when the change was completed: pull requests merged and the ticket closed. */
  completedAt?: string;
};

export type WidgetState = "ok" | "pending" | "warn" | "none" | "error";

/** One item inside a widget, e.g. a repo, a PR, a build. */
export type WidgetItem = {
  label: string;
  detail?: string;
  /** Colours the detail text, for things that ask for attention rather than describe. */
  detailTone?: WidgetState;
  url?: string;
  state?: WidgetState;
  /** Actions applicable to this item; `arg` is passed back to the integration. `confirm` asks
   * the question before running, for anything that could surprise. */
  actions?: { id: string; label: string; arg?: string; confirm?: string }[];
  /** Actions that belong to the row but not on it: shown behind a ⋯ button, for things you do
   * occasionally (open this repository somewhere) rather than act on. */
  menu?: { id: string; label: string; arg?: string; confirm?: string }[];
  /** Something still running: the browser ticks the elapsed time and draws a bar against the
   * expected duration, so a 15s poll does not make the clock stutter. */
  progress?: { startedAt: string; expectedMs?: number };
  /** Nested rows, rendered as a collapsible tree: repo > pull request > pipeline > runs. */
  children?: WidgetItem[];
};

/** What one integration reports about one change: the dashboard renders this as a card. */
export type Widget = {
  integration: string;
  title: string;
  state: WidgetState;
  summary: string;
  items: WidgetItem[];
};

export type Integration = {
  name: string;
  title: string;
  /** Asks for the tall column of its own on a wide window: the tree of a CI component is much
   * taller than the rest put together. */
  wide?: boolean;
  /** Whole-widget status, for components that do not work per repository (Jira). */
  status?(change: Change): Promise<Widget>;
  /** Rows for one repository. Components that have these are fetched a repository at a time, so
   * a change with many repositories fills in one by one instead of all at the end. */
  repoStatus?(change: Change, repo: string): Promise<WidgetItem[]>;
  /** Bring this component in line with a newly created change: worktrees, ticket status, ... */
  provision?(change: Change): Promise<void>;
  /** Perform `action` (an id handed out by `status`) on this change. */
  run?(change: Change, action: string, arg?: string): Promise<void>;
};

/** One thing completing a change does, and how it went. Written to disk as it happens: a
 * completion that stops half way — a merge that hung, a ticket that refused to move — has to be
 * legible afterwards, from a page that was never open. */
export type CompletionStep = {
  id: string;
  label: string;
  state: "waiting" | "running" | "done" | "failed";
  /** What it did, or why it did not. */
  detail?: string;
};

export type CompletionProgress = {
  startedAt: string;
  finishedAt?: string;
  steps: CompletionStep[];
  /** Set when a step failed; the change is left as that step found it. */
  error?: string;
};

/** One file git has something to say about, in the vocabulary git itself uses. Lives here rather
 * than in local.ts because the page needs the type and must not pull the server's modules in. */
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
