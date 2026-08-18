import { basename } from "node:path";
import type { Change, WidgetItem, WidgetState } from "../types.ts";
import { worktreeFor } from "./git.ts";
import { sh, shOrThrow, json } from "../sh.ts";

type Pr = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string | null;
  mergeable?: string | null;
  statusCheckRollup: { conclusion?: string; state?: string }[] | null;
};

/** What the pull request is waiting for. Unresolved threads do not hide the review decision:
 * "approved with comments still open" is a real and interesting state. */
export function readiness(
  pr: { reviewDecision?: string | null; mergeable?: string | null },
  unresolved = 0,
): { text: string; tone?: WidgetState } {
  const comments = unresolved
    ? `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}`
    : undefined;
  const say = (text: string, tone?: WidgetState) => ({
    text: [comments, text].filter(Boolean).join(" · "),
    tone: comments ? ("warn" as WidgetState) : tone,
  });

  if (pr.mergeable === "CONFLICTING") return say("conflicts", "error");
  switch (pr.reviewDecision) {
    case "APPROVED":
      // Approved, but open threads mean it is not simply ready: say approved, not ready to merge.
      return comments ? say("approved") : say("ready to merge", "ok");
    case "CHANGES_REQUESTED":
      return say("changes requested", "warn");
    default:
      return say("review required");
  }
}

/** SUCCESS/FAILURE come from checks, SUCCESS/PENDING from commit statuses; treat both. */
function checksState(pr: Pr): { state: WidgetState; text: string } {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return { state: pr.isDraft ? "pending" : "ok", text: "no checks" };
  const results = checks.map((c) => c.conclusion || c.state || "");
  const failed = results.filter((r) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(r)).length;
  const running = results.filter((r) => ["PENDING", "IN_PROGRESS", "QUEUED", ""].includes(r)).length;
  if (failed) return { state: "error", text: `${failed} failing` };
  if (running) return { state: "pending", text: `${running} running` };
  return { state: "ok", text: "checks passed" };
}

/** gh needs a repository as its working directory; the worktree is the one we know is on the
 * change's branch. Returns undefined when the worktree does not exist yet. */
async function prQuery(
  change: Change,
  repo: string,
): Promise<{ worktree: string; prs: Pr[] } | undefined> {
  const wt = await worktreeFor(change, repo);
  if (!wt) return undefined;
  const r = await sh(
    [
      "gh",
      "pr",
      "list",
      "--head",
      change.branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup",
    ],
    wt,
  );
  if (r.code !== 0) throw new Error(r.stderr.split("\n")[0] ?? "gh failed");
  return { worktree: wt, prs: json<Pr[]>(r.stdout, []) };
}

/** Owner and name from a pull request URL, so counting threads costs no extra lookup. */
export function repoFromUrl(url: string): { owner: string; name: string } | undefined {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(url);
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

const threadsQuery =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name)" +
  "{pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";

/** Unresolved review threads: the only comment count worth acting on. Resolved ones are done,
 * and REST exposes neither, hence GraphQL. */
async function unresolvedThreads(
  worktree: string,
  url: string,
  number: number,
): Promise<number | undefined> {
  const repo = repoFromUrl(url);
  if (!repo) return undefined;
  const r = await sh(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${threadsQuery}`,
      "-F",
      `owner=${repo.owner}`,
      "-F",
      `name=${repo.name}`,
      "-F",
      `number=${number}`,
      "--jq",
      "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length",
    ],
    worktree,
  );
  return r.code === 0 ? (json<number>(r.stdout, 0) ?? 0) : undefined;
}

/** The pull request for this change in `repo`, plus a row describing it. */
export async function prItem(
  change: Change,
  repo: string,
): Promise<{ number?: number; item: WidgetItem }> {
  // The repository is the parent row in the tree, so these labels do not repeat it.
  const label = "pull request";
  let found: { worktree: string; prs: Pr[] } | undefined;
  try {
    found = await prQuery(change, repo);
  } catch (e) {
    return { item: { label, detail: e instanceof Error ? e.message : String(e), state: "error" } };
  }
  if (!found) return { item: { label, detail: "no worktree", state: "none" } };
  const pr = found.prs[0];
  if (!pr) {
    return {
      item: {
        label: "no pull request",
        detail: "not pushed yet",
        state: "none",
        actions: [{ id: "create", label: "Push & create PR", arg: repo }],
      },
    };
  }
  const checks = checksState(pr);
  // No check text: the dot carries the check state and the runs are listed underneath. Draft,
  // merged and closed are the exceptions, since nothing else on the row says so. Comment counts
  // are the one thing you cannot see anywhere else on this page.
  const notable = pr.isDraft ? "draft" : ["MERGED", "CLOSED"].includes(pr.state) ? pr.state.toLowerCase() : undefined;
  // A merged or closed pull request is not waiting for anything, so it only says so.
  const settled = ["MERGED", "CLOSED"].includes(pr.state);
  const unresolved = settled ? 0 : ((await unresolvedThreads(found.worktree, pr.url, pr.number)) ?? 0);
  const status = settled ? { text: "", tone: undefined } : readiness(pr, unresolved);
  return {
    number: pr.number,
    item: {
      label: `#${pr.number} ${pr.title}`,
      detail: [notable, status.text].filter(Boolean).join(" · ") || undefined,
      detailTone: status.tone,
      url: pr.url,
      state: pr.state === "MERGED" ? "ok" : checks.state,
    },
  };
}

/** Whether this repository's pull request may be merged as part of completing the change. */
export type MergeReadiness =
  | { ready: true; merged: true }
  | { ready: true; merged: false; number: number }
  | { ready: false; reason: string };

export async function mergeReadiness(change: Change, repo: string): Promise<MergeReadiness> {
  const name = basename(repo);
  const found = await prQuery(change, repo);
  if (!found) return { ready: false, reason: `${name}: no worktree` };
  const pr = found.prs[0];
  if (!pr) return { ready: false, reason: `${name}: no pull request` };
  if (pr.state === "MERGED") return { ready: true, merged: true };
  if (pr.state === "CLOSED") return { ready: false, reason: `${name}: pull request is closed` };
  if (pr.isDraft) return { ready: false, reason: `${name}: pull request is a draft` };
  if (pr.mergeable === "CONFLICTING") return { ready: false, reason: `${name}: conflicts` };
  if (pr.reviewDecision !== "APPROVED") {
    const decision = (pr.reviewDecision ?? "review required").toLowerCase().replace(/_/g, " ");
    return { ready: false, reason: `${name}: not approved (${decision})` };
  }
  return { ready: true, merged: false, number: pr.number };
}

/** Squash-merge the pull request. Both Acme repositories allow squash only, and delete the
 * remote branch themselves; --delete-branch also drops the local one. */
export async function mergePr(change: Change, repo: string, number: number): Promise<void> {
  const wt = await worktreeFor(change, repo);
  if (!wt) throw new Error(`no worktree for ${change.branch} in ${repo}`);
  await shOrThrow(["gh", "pr", "merge", String(number), "--squash"], wt);
}

/** Push the branch and open a pull request for it. */
export async function createPr(change: Change, repo: string): Promise<void> {
  const wt = await worktreeFor(change, repo);
  if (!wt) throw new Error(`no worktree for ${change.branch} in ${repo}`);
  await shOrThrow(["git", "push", "-u", "origin", change.branch], wt);
  await shOrThrow(["gh", "pr", "create", "--fill"], wt);
}
