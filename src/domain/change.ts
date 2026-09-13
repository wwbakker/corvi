import type { SummaryFact, WidgetState } from "./widget.ts";

/**
 * Where a change stands, as you see it. Kept by hand rather than derived: the tools disagree
 * often enough (a merged PR with the ticket still open, review happening in a call) that your
 * own answer is the useful one. Completing a change sets it to "Completed", cancelling one sets
 * it to "Cancelled".
 *
 * The order is the lifecycle: an idea comes before the work it starts, work you can get on with
 * comes before work that is with somebody else, which comes before work that is stuck, and the
 * finished states close it. It is used twice: the select offers them in this order, and the
 * lists sort by it. The lists then group `Ideation` into its own block rather than interleaving
 * it on rank, so the block reads as "ideas" first and the attention order below it stays put.
 *
 * "Blocked" is waiting on something you cannot do yourself — an answer, a decision, another
 * change — as opposed to "Awaiting Review", which is waiting on a named person to look at
 * finished work.
 *
 * "Ideation" is before any work exists: a plan and a conversation with an agent, no branch and
 * no worktree yet. It is what creating a change sets, and it is left by starting the work — a
 * real transition, not a word you pick from the select (see `applyPatch`).
 */
export const CHANGE_STATES = [
  "Ideation",
  "In Progress",
  "Awaiting Review",
  "Blocked",
  "Completed",
  "Cancelled",
] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

/** The state a change is in before its work has started. The one state that is set by creation
 * and left only by starting, so it is not offered as an editable word. */
export const IDEATION: ChangeState = "Ideation";

/** Whether this change is still an idea: no work has started, so there is no branch or worktree
 * to reason about, only the plan. */
export const isIdeation = (change: Pick<Change, "state">): boolean =>
  (change.state ?? "In Progress") === IDEATION;

/** The file an idea's plan lives in, at the change root. Its name is what the agent is told and
 * what the dashboard edits, so it is stated once — and it is a core sidecar
 * (src/change/server/store.ts), so it archives with the change. */
export const PLAN_FILE = "PLAN.md";

/** The states a change is over in. Both are archived and neither is worked on again; they differ
 * in what happened, which is worth keeping — a change that was abandoned is not one that landed. */
export const FINISHED_STATES: ChangeState[] = ["Completed", "Cancelled"];

/** Whether this change is over. `completedAt` is the fact — it is set by finishing the change,
 * whichever way — and the state says which way. An idea is not finished: it is work you have
 * not started, not work that is over. */
export const isFinished = (change: Pick<Change, "state" | "completedAt">): boolean =>
  Boolean(change.completedAt) || FINISHED_STATES.includes(change.state ?? "In Progress");

/**
 * The order the lists show changes in: by state, then newest first.
 *
 * What you are working on is at the top, what somebody else has is next, what is stuck is last —
 * and within each, the change you started most recently, because that is the one you are most
 * likely to be looking for. Ideas come first, being the newest thing there is; the overview and
 * the navigation column group them out, so this rank only orders them among themselves.
 */
export function byWorkOrder(a: Change, b: Change): number {
  const rank = (c: Change): number => CHANGE_STATES.indexOf(c.state ?? "In Progress");
  return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
}

/** A title as an identifier: `Ideation Stage` becomes `ideation-stage`. The same normalization
 * `branchFor` gives a ticket summary, without the ticket-key prefix, bounded so it stays a usable
 * directory and branch name. */
export function slugFor(title: string): string {
  return slugify(title).slice(0, 60).replace(/-+$/, "");
}

/** The shared normalization: fold accents to ASCII, lowercase, and join word characters with
 * single hyphens — the one statement `slugFor` and `branchFor` both apply. */
function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents so branch names stay ASCII
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Default branch name for a picked issue: `PROJ-123-short-summary`. A default, not a rule —
 * the form lets you edit it before the change is created. */
export function branchFor(key: string, summary: string): string {
  return `${key}-${slugify(summary)}`.slice(0, 60).replace(/-+$/, "");
}

/** The creation input, before a change exists: what the "New idea" wizard collected and what
 * the `change:creating` hooks transform. Everything but the id is optional, because the core
 * fills the gaps (branch defaults to the id, state to "In Progress", createdAt to now).
 *
 * `state: "Ideation"` is what makes an idea: no repositories are required, and the change is
 * written without a branch or worktree — starting it is what provisions those. Any other state
 * (or none) is a change created ready to work, which needs at least one repository.
 *
 * Defined with the domain vocabulary rather than beside the hooks that receive it: it is the
 * same shape the core's `<change> create` takes, and the contract re-exports it for extension
 * authors (src/extension-host/api/lifecycle.ts). */
export type ChangeDraft = {
  /** Directory name under the changes root; also the default branch name. */
  id: string;
  /** The change's own name, when one was typed rather than taken from a ticket. Stored as the
   * change's title with `titleEdited`, so a ticket source never overwrites it. */
  title?: string;
  /** Branch used in every repo worktree of this change. Defaults to the id. */
  branch?: string;
  /** Absolute paths to the source repositories this change touches. */
  repos?: string[];
  /** The subset of `repos` worked on in place. */
  direct?: string[];
  /** Branch each repository's work started from, keyed by repository path. */
  base?: Record<string, string>;
  /** Which context this change belongs to. Absent belongs to the first workspace. */
  workspace?: string;
  /** The state to create it in. Absent means "In Progress"; `Ideation` makes an idea. */
  state?: ChangeState;
  /** Each extension's own data about this change, keyed by extension name. */
  extensions?: Record<string, unknown>;
};

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
   * remote's default branch. */
  base?: Record<string, string>;
  /** The subset of `repos` worked on in place: the repository's own checkout is switched to the
   * branch and linked from the change directory, instead of getting a worktree. */
  direct?: string[];
  /** Which context this change belongs to: a client, or your own projects. Absent belongs to the
   * first workspace. */
  workspace?: string;
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
  /** Absent is treated as "In Progress". */
  state?: ChangeState;
  createdAt: string;
  /** Set when the change was finished, whichever way: completed (pull requests merged, ticket
   * closed) or cancelled (worktrees removed, nothing merged). */
  completedAt?: string;
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

/** What a change's card and its entry in the navigation column say beyond the change itself:
 * the facts its extensions contribute, and the worst verdict among them for the navigation's
 * icon. Lives here rather than in dashboard/server/summary.ts because the page needs the
 * type and must not pull the server's modules in. */
export type ChangeSummary = {
  /** One fact per contributed line, in the order they should read. */
  facts: SummaryFact[];
  /** How the builds are doing, across every repository: the worst verdict offered, since one
   * red build is what you want to know about. "none" when nothing has a verdict. */
  state: WidgetState;
};
