import { basename } from "node:path";
import type { Change, WidgetItem, WidgetState } from "../types.ts";
import { worktreeFor, baseFor, remoteDefaultBranch } from "./git.ts";
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

/** Where a pull request sits in its stack, when it is in one. */
export type Stack = { number: number; size: number; position: number };

type Details = { unresolved?: number; stack?: Stack };

const detailsQuery = (withStack: boolean): string =>
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name)" +
  "{pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}" +
  (withStack ? " stack{number size} stackEntry{position}" : "") +
  "}}}";

type DetailsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: { isResolved: boolean }[] };
        stack?: { number: number; size: number } | null;
        stackEntry?: { position: number } | null;
      };
    };
  };
};

/**
 * Unresolved review threads and stack membership in one query: the only comment count worth
 * acting on (resolved ones are done), and where this pull request sits in a stack. REST exposes
 * neither on the list endpoint, hence GraphQL.
 *
 * Stacked pull requests are a preview feature: where it is not enabled the fields do not exist
 * and the whole query fails, so that case asks again without them rather than losing the counts.
 */
async function prDetails(worktree: string, url: string, number: number): Promise<Details> {
  const repo = repoFromUrl(url);
  if (!repo) return {};
  const ask = async (withStack: boolean) =>
    sh(
      [
        "gh",
        "api",
        "graphql",
        "-f",
        `query=${detailsQuery(withStack)}`,
        "-F",
        `owner=${repo.owner}`,
        "-F",
        `name=${repo.name}`,
        "-F",
        `number=${number}`,
      ],
      worktree,
    );
  let r = await ask(true);
  if (r.code !== 0) r = await ask(false);
  if (r.code !== 0) return {};

  const pr = json<DetailsResponse>(r.stdout, {}).data?.repository?.pullRequest;
  const stack = pr?.stack;
  const position = pr?.stackEntry?.position;
  return {
    unresolved: (pr?.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    stack: stack && position ? { number: stack.number, size: stack.size, position } : undefined,
  };
}

/** How a stack reads on the pull request row. */
export const describeStack = (stack: Stack): string =>
  `${stack.position} of ${stack.size} in stack #${stack.number}`;

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
  const details = await prDetails(found.worktree, pr.url, pr.number);
  const unresolved = settled ? 0 : (details.unresolved ?? 0);
  const status = settled ? { text: "", tone: undefined } : readiness(pr, unresolved);
  return {
    number: pr.number,
    item: {
      label: `#${pr.number} ${pr.title}`,
      // The stack goes last: it describes the work around this pull request, not its state.
      detail:
        [notable, status.text, details.stack && describeStack(details.stack)]
          .filter(Boolean)
          .join(" · ") || undefined,
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

/** GitHub's stacked pull requests are a preview feature, so the API version has to be asked for
 * by name. */
const STACKS_API = ["-H", "X-GitHub-Api-Version: 2026-03-10"];

/**
 * The call that puts a new pull request on top of the one below it: appended to that pull
 * request's stack when it already has one, otherwise a stack of the two of them.
 *
 * Pull requests are given bottom to top, and each one's base must be the previous one's head —
 * which is exactly how a change based on another change's branch is already set up.
 */
export function stackRequest(
  repo: string,
  below: number,
  number: number,
  stack?: number,
): string[] {
  return stack
    ? [`repos/${repo}/stacks/${stack}/add`, "-F", `pull_requests[]=${number}`]
    : [`repos/${repo}/stacks`, "-F", `pull_requests[]=${below}`, "-F", `pull_requests[]=${number}`];
}

/**
 * Tie a new pull request to the one it was branched off, as a GitHub stack: reviewers then see
 * the order of the work, and merging the bottom one moves the rest along.
 *
 * Best effort. The stack is a nicety on top of a pull request that already targets the right
 * branch, so a repository without the preview feature, or a base branch with no pull request of
 * its own, changes nothing else.
 */
async function stackOnBase(worktree: string, baseBranch: string, number: number): Promise<void> {
  const repo = (await sh(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], worktree)).stdout;
  const below = json<{ number: number }[]>(
    (await sh(["gh", "pr", "list", "--head", baseBranch, "--state", "open", "--json", "number", "--limit", "1"], worktree)).stdout,
    [],
  )[0]?.number;
  if (!repo || !below) return; // the branch below has no pull request: nothing to stack onto

  const stack = json<{ stack?: { number?: number } }>(
    (await sh(["gh", "api", `repos/${repo}/pulls/${below}`, ...STACKS_API], worktree)).stdout,
    {},
  ).stack?.number;
  const r = await sh(
    ["gh", "api", "-X", "POST", ...STACKS_API, ...stackRequest(repo, below, number, stack)],
    worktree,
  );
  if (r.code !== 0) console.warn(`could not stack #${number} onto #${below}: ${r.stderr.trim()}`);
}

/** Push the branch and open a pull request for it. */
export async function createPr(change: Change, repo: string): Promise<void> {
  const wt = await worktreeFor(change, repo);
  if (!wt) throw new Error(`no worktree for ${change.branch} in ${repo}`);
  await shOrThrow(["git", "push", "-u", "origin", change.branch], wt);
  // A change stacked on another one's branch must open its pull request against that branch:
  // against main the diff would contain the other change's commits as well. GitHub retargets
  // the pull request to main by itself once the base branch merges.
  const base = await baseFor(change, repo);
  const target = base?.startsWith("origin/") ? base.slice("origin/".length) : base;
  const against = target && (await remoteDefaultBranch(repo)) !== base ? ["--base", target] : [];
  await shOrThrow(["gh", "pr", "create", "--fill", ...against], wt);
  if (against.length) {
    const number = Number(
      (await sh(["gh", "pr", "view", "--json", "number", "-q", ".number"], wt)).stdout,
    );
    if (number) await stackOnBase(wt, target!, number);
  }
}

export type Check = {
  name: string;
  state: string;
  bucket: string;
  link?: string;
  startedAt?: string;
  completedAt?: string;
};

/** GitHub's own word for a check, which is the only vocabulary shared by Actions, Azure Pipelines
 * in any project, Cypress and whatever else a repository has bolted on. */
const checkState = (bucket: string): WidgetState =>
  ({ pass: "ok", fail: "error", pending: "pending", skipping: "none", cancel: "warn" })[bucket] as
    | WidgetState
    | undefined ?? "none";

/**
 * The checks of a pull request, as the tree shows them when Azure DevOps has nothing to say about
 * this repository: its pipelines live in another project, or it is built by GitHub Actions.
 *
 * Names like `acme.frontend-app (CI App @acme/example-app)` are grouped by the part before
 * the bracket, so thirty jobs of one build read as one row you can open.
 */
export async function checkItems(change: Change, repo: string, number: number): Promise<WidgetItem[]> {
  const worktree = (await worktreeFor(change, repo)) ?? repo;
  // Non-zero means "something is failing or pending", which is a result, not an error.
  const r = await sh(
    ["gh", "pr", "checks", String(number), "--json", "name,state,bucket,link,startedAt,completedAt"],
    worktree,
  );
  return groupChecks(json<Check[]>(r.stdout, []));
}

/** Grouped by the part of the name before the bracket, so thirty jobs of one build read as one
 * row you can open. */
export function groupChecks(checks: Check[]): WidgetItem[] {
  if (checks.length === 0) return [];
  const groups = new Map<string, Check[]>();
  for (const check of checks) {
    const group = check.name.split(" (")[0]!;
    groups.set(group, [...(groups.get(group) ?? []), check]);
  }
  return [...groups].map(([name, members]): WidgetItem => {
    const states = members.map((c) => checkState(c.bucket));
    const state = states.includes("error")
      ? "error"
      : states.includes("pending")
        ? "pending"
        : states.includes("ok")
          ? "ok"
          : "none";
    const failed = states.filter((s) => s === "error").length;
    const running = states.filter((s) => s === "pending").length;
    return {
      label: name,
      detail: [
        `${members.length} check${members.length === 1 ? "" : "s"}`,
        failed ? `${failed} failing` : undefined,
        running ? `${running} running` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      state,
      url: members.length === 1 ? members[0]!.link : undefined,
      // A single check is its own row already; more than one is worth opening.
      children:
        members.length === 1
          ? undefined
          : members.map((c): WidgetItem => ({
              // The check named exactly like the group is the build as a whole; the rest are its
              // jobs, named by what is left after the group's name.
              label: c.name.slice(name.length).replace(/^ \(|\)$/g, "") || "overall",
              detail: c.state.toLowerCase(),
              url: c.link,
              state: checkState(c.bucket),
              progress: c.bucket === "pending" && c.startedAt ? { startedAt: c.startedAt } : undefined,
            })),
    };
  });
}
