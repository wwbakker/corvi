/** Where a change stands, as you see it. Kept by hand rather than derived: the tools disagree
 * often enough (a merged PR with the ticket still open, review happening in a call) that your
 * own answer is the useful one. Completing a change sets it to "Completed". */
export const CHANGE_STATES = ["In Progress", "Awaiting Review", "Completed"] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

/** A unit of work spanning one or more repositories, plus the tickets/PRs/builds around it. */
export type Change = {
  /** Directory name under the changes root; also the default branch name. */
  id: string;
  /** Branch used in every repo worktree of this change. */
  branch: string;
  /** Absolute paths to the source repositories this change touches. Editable later. */
  repos: string[];
  /** Optional Jira issue key, e.g. PROJ-123. */
  jira?: string;
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
