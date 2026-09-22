/**
 * The change record's vocabulary and the pure rules both the server and the page apply.
 *
 * The record itself is the contract's wire shape (`@corvi/contracts/api`'s `ChangeWireDto`);
 * this module adds the words that go with it — the states, the ideation rule, the work order —
 * so the page can sort and label changes without importing any server module.
 */
import type {
  ChangeSummaryDto,
  ChangeWireDto,
  CompletionDto,
  CompletionProgressDto,
  CompletionReasonDto,
  CompletionStepDto,
} from "@corvi/contracts/api";

/** The change record, as `change.json` holds it. */
export type Change = ChangeWireDto;

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
 * what the dashboard edits, so it is stated once — and it is a core sidecar, so it archives with
 * the change. */
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

/** The name a repository path is filed under: its last component, trailing separators ignored.
 * Split by hand rather than with node:path, because this half of the domain is also bundled for
 * the browser. */
function repoNameOf(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** Repository names that appear more than once in a list of repository paths. Every repository a
 * change touches is filed in the change directory under its own name — a worktree, or the link an
 * idea and an in-place checkout use — so two paths with the same last component would collide
 * there. A creation or an edit that would leave two of them is refused, naming them. */
export function duplicateRepoNames(repos: string[]): string[] {
  const counts = new Map<string, number>();
  for (const repo of repos) {
    const name = repoNameOf(repo);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
}

/** What the creation input is: what the "New idea" wizard collected. Everything but the id
 * is optional, because the core fills the gaps (branch defaults to the id, state to
 * "In Progress", createdAt to now).
 *
 * `state: "Ideation"` is what makes an idea: no repositories are required, and the change is
 * written without a branch or worktree — starting it is what provisions those. Any other state
 * (or none) is a change created ready to work, which needs at least one repository.
 */
/** What provisioning one repository target reported, shown after a create or a start. A failure
 * carries the first error and stops that integration's later work; the change itself survives. */
export type ProvisionResult = { integration: string; ok: boolean; error?: string };

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

/** One thing completing a change does, and how it went. Written to disk as it happens: a
 * completion that stops half way — a merge that hung, a ticket that refused to move — has to be
 * legible afterwards, from a page that was never open. */
export type CompletionStep = CompletionStepDto;

export type CompletionProgress = CompletionProgressDto;

/** One unmet requirement of a change's completion, tagged so the page knows whether to offer an
 * override dialog or a plain refusal. `forceable` reasons can be acknowledged away; `hard` ones
 * (uncommitted work, still an idea) refuse outright, even with force. */
export type CompletionReason = CompletionReasonDto;

/** Whether a change can be completed right now: what still blocks it, tagged, and which pull
 * requests are still to merge. The page reads it too and must not pull the server's modules in. */
export type Completion = CompletionDto;

/** A completion's refusal, in the shape the override dialog renders: the tagged reasons plus
 * what is still mergeable, so the dialog lists server truth rather than the poll. */
export type CompletionRefusal = { reasons: CompletionReason[]; toMerge: Completion["toMerge"] };

/** What a change's card and its entry in the navigation column say beyond the change itself:
 * the facts its extensions contribute, and the worst verdict among them for the navigation's
 * icon. */
export type ChangeSummary = ChangeSummaryDto;
