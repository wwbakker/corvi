/**
 * Where a change stands, as you see it. Kept by hand rather than derived: the tools disagree
 * often enough (a merged PR with the ticket still open, review happening in a call) that your
 * own answer is the useful one. Completing a change sets it to "Completed", cancelling one sets
 * it to "Cancelled".
 *
 * The order is how much of your attention the state asks for, and it is used twice: the select
 * offers them in this order, and the lists sort by it. Work you can get on with comes before
 * work that is with somebody else, which comes before work that is stuck.
 *
 * "Blocked" is waiting on something you cannot do yourself — an answer, a decision, another
 * change — as opposed to "Awaiting Review", which is waiting on a named person to look at
 * finished work.
 */
export const CHANGE_STATES = [
  "In Progress",
  "Awaiting Review",
  "Blocked",
  "Completed",
  "Cancelled",
] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

/** The states a change is over in. Both are archived and neither is worked on again; they differ
 * in what happened, which is worth keeping — a change that was abandoned is not one that landed. */
export const FINISHED_STATES: ChangeState[] = ["Completed", "Cancelled"];

/** Whether this change is over. `completedAt` is the fact — it is set by finishing the change,
 * whichever way — and the state says which way. */
export const isFinished = (change: Pick<Change, "state" | "completedAt">): boolean =>
  Boolean(change.completedAt) || FINISHED_STATES.includes(change.state ?? "In Progress");

/**
 * The order the lists show changes in: by state, then newest first.
 *
 * What you are working on is at the top, what somebody else has is next, what is stuck is last —
 * and within each, the change you started most recently, because that is the one you are most
 * likely to be looking for.
 */
export function byWorkOrder(a: Change, b: Change): number {
  const rank = (c: Change): number => CHANGE_STATES.indexOf(c.state ?? "In Progress");
  return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
}

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
  /** Which context this change belongs to: a client, or your own projects. Absent on changes
   * made before workspaces existed, which belong to the first one. */
  workspace?: string;
  /** Optional Jira issue key, e.g. PROJ-123. Legacy: the jira extension's own field, from
   * before extensions kept their data in the namespaced bag below. Still read, no longer
   * written by the wizard. */
  jira?: string;
  /** Each extension's own data about this change, keyed by extension name — the wizard stores
   * what its steps picked here, and each extension reads its own entry. Anything JSON-shaped
   * goes; the extension owns its shape, the core never looks inside. */
  extensions?: Record<string, unknown>;
  /** What the change is called. Taken from the ticket's summary and refreshed from it, unless
   * you have written your own — kept so the overview can name a change without a CLI call per
   * row, and so an archived change still reads as English years later. */
  title?: string;
  /** The title is yours, not Jira's: stop refreshing it from the ticket. Set by editing it. */
  titleEdited?: boolean;
  /** Absent on changes made before this existed; treated as "In Progress". */
  state?: ChangeState;
  createdAt: string;
  /** Set when the change was finished, whichever way: completed (pull requests merged, ticket
   * closed) or cancelled (worktrees removed, nothing merged). */
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

/** What one extension reports about one change: the dashboard renders this as a card. The
 * `integration` field is the extension's name — the identity the browser knows the card by. */
export type Widget = {
  integration: string;
  title: string;
  state: WidgetState;
  summary: string;
  items: WidgetItem[];
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

/** What a change's card and its entry in the navigation column say beyond the change itself:
 * the three things that change while you are not looking at it. Lives here rather than in
 * summary.ts because the page needs the type and must not pull the server's modules in. */
export type ChangeSummary = {
  /** Pipeline runs in flight across every repository of the change. */
  pipelines: number;
  /** tmux windows running something other than a shell: a build, an editor, a server. */
  terminals: number;
  /** Windows in the change's tmux session, so "idle" can be told from "no terminal". */
  windows: number;
  /** Open review threads across every pull request of the change. */
  unresolved: number;
  /** How the builds are doing, across every repository: the worst of them, since one red build
   * is what you want to know about. */
  ci: WidgetState;
};
