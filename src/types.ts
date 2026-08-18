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
  status(change: Change): Promise<Widget>;
  /** Bring this component in line with a newly created change: worktrees, ticket status, ... */
  provision?(change: Change): Promise<void>;
  /** Perform `action` (an id handed out by `status`) on this change. */
  run?(change: Change, action: string, arg?: string): Promise<void>;
};
