import { beforeEach, expect, test } from "bun:test";
import { Effect, Either, Layer } from "effect";
import {
  createPr,
  headRef,
  mergePr,
  mergeReadiness,
  prItem,
  prSummary,
  readiness,
  repoFromUrl,
  waitingOnYou,
  type MergeReadiness,
} from "../src/integrations/github.ts";
import {
  createIssue,
  listIssues,
  nameWithOwner,
  repoFromRemote,
  viewIssue,
} from "../src/extensions/github-issues/index.ts";
import githubIssues from "../src/extensions/github-issues/index.ts";
import { clearCache } from "../src/cache.ts";
import { config } from "../src/config.ts";
import { Shell, Workspace as WorkspaceTag } from "../src/effect/tags.ts";
import type { Capabilities } from "../src/extensions/api.ts";
import { BusLive, CacheLive, SettingsLive } from "../src/extensions/services.ts";
import { workspaceById } from "../src/workspaces.ts";
import type { Result } from "../src/sh.ts";
import type { Change } from "../src/types.ts";
import { fakeShell, runWithShell, type FakeShell } from "./helpers.ts";

/**
 * `src/integrations/github.ts` and the github-issues extension, driven through the fake-Shell
 * seam. The core functions reach `gh` and `git` through `sh`, which prefers a Shell in context;
 * the extension functions take the `Shell` and `Cache` services directly, so the layers below
 * provide the whole capability union with a scripted Shell in place of the live one.
 */

beforeEach(() => clearCache());

// --- Drivetrain -------------------------------------------------------------------------------

const change = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-1",
  branch: "feature",
  repos: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const withRef = (repo: string, number: number): Change =>
  change({ extensions: { "github-issues": { repo, number } } });

const withRefId = (id: string, repo: string, number: number): Change =>
  change({ id, branch: id, extensions: { "github-issues": { repo, number } } });

/** A pull request as `gh pr list --json` returns one, with the fields this file reads. */
const pr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: "Do the thing",
  url: "https://github.com/org/repo/pull/7",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
  ...over,
});

type GhShellOptions = {
  repo: string;
  branch?: string;
  upstream?: string;
  remoteDefault?: string;
  noRemote?: boolean;
  noWorktree?: boolean;
  prs?: readonly Record<string, unknown>[];
  prListCode?: number;
  prListStderr?: string;
  details?: unknown;
  /** Answer the stacks-preview GraphQL query with a failure, so the retry path is exercised. */
  stackQueryFails?: boolean;
  /** Answers for commands the helper does not know; the shared commands stay scripted. */
  gh?: (line: string) => string | Partial<Result> | undefined;
};

/** A fake Shell that answers the git reads a worktree lookup makes plus `gh pr list`, and
 * hands anything else to `opts.gh`. Each test uses its own repo path, because git's default
 * branch is memoized per repository. */
const ghShell = (opts: GhShellOptions): FakeShell => {
  const branch = opts.branch ?? "feature";
  const upstream = opts.upstream ?? `origin/${branch}`;
  const remoteDefault = opts.remoteDefault ?? "origin/main";
  // A pull request is looked up by the branch that was pushed, which is the upstream's name
  // unless it lines up with the local branch.
  const head = headRef(branch, upstream, remoteDefault);
  const prLine =
    `gh pr list --head ${head} --state all --limit 1 ` +
    "--json number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup";
  return fakeShell((cmd) => {
    const line = cmd.join(" ");
    const custom = opts.gh?.(line);
    if (custom !== undefined) return custom;
    if (cmd[0] === "git") {
      if (line === "git worktree list --porcelain") {
        return opts.noWorktree
          ? ""
          : `worktree ${opts.repo}\nHEAD abc\nbranch refs/heads/${branch}\n`;
      }
      if (line === "git status --porcelain=v2 --branch") {
        return `# branch.head ${branch}\n# branch.upstream ${upstream}\n# branch.ab +0 -0\n`;
      }
      if (line === "git remote") return opts.noRemote ? "" : "origin";
      if (line === "git symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return remoteDefault;
      }
      if (line === `git rev-parse --abbrev-ref --symbolic-full-name ${branch}@{upstream}`) {
        return upstream;
      }
      return undefined;
    }
    if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
      // `shSoft` is handed a non-zero code, which makes readDetails ask again without the
      // stack fields; the second query has no "stack" in it.
      if (opts.stackQueryFails && cmd[4]?.includes("stack")) {
        return { code: 1, stderr: "stack not available" };
      }
      return JSON.stringify(opts.details ?? { data: {} });
    }
    if (line === prLine) {
      return opts.prListCode
        ? { code: opts.prListCode, stderr: opts.prListStderr ?? "gh pr list failed" }
        : JSON.stringify(opts.prs ?? []);
    }
    return undefined;
  });
};

/** Run a core github.ts effect with a fake Shell, capturing a failure instead of rejecting. */
const runEither = <A, E>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, never>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(
    Effect.either(
      Effect.provide(
        effect,
        Layer.mergeAll(
          Layer.succeed(Shell, shell),
          Layer.succeed(WorkspaceTag, workspaceById(undefined)),
        ),
      ),
    ),
  );

/** Everything an extension effect may require, with the scripted Shell in place of the live one. */
const extLayer = (shell: FakeShell): Layer.Layer<Capabilities> =>
  Layer.mergeAll(
    Layer.succeed(Shell, shell),
    CacheLive,
    SettingsLive,
    BusLive,
    Layer.succeed(WorkspaceTag, workspaceById(undefined)),
  );

const runExtension = <A, E>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, Capabilities>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, extLayer(shell)));

const runExtensionEither = <A, E>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, Capabilities>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(Effect.provide(effect, extLayer(shell))));

// --- Pure decisions ---------------------------------------------------------------------------

test("readiness: an unresolved comment keeps its tone when the pull request also conflicts", () => {
  // Conflicts win the words, but comments win the tone: they are the thing asking for a person.
  expect(readiness({ mergeable: "CONFLICTING" }, 1)).toEqual({
    text: "1 unresolved comment · conflicts",
    tone: "warn",
  });
  expect(readiness({ mergeable: "CONFLICTING" }, 2)).toEqual({
    text: "2 unresolved comments · conflicts",
    tone: "warn",
  });
  // Without comments the conflict's own error tone stands.
  expect(readiness({ mergeable: "CONFLICTING" })).toEqual({ text: "conflicts", tone: "error" });
  // Approved with open threads is approved, not ready to merge.
  expect(readiness({ reviewDecision: "APPROVED" }, 1)).toEqual({
    text: "1 unresolved comment · approved",
    tone: "warn",
  });
  expect(readiness({ reviewDecision: "CHANGES_REQUESTED" }, 2)).toEqual({
    text: "2 unresolved comments · changes requested",
    tone: "warn",
  });
});

test("headRef: an upstream with no branch part falls back to the local branch", () => {
  // No slash to take a name from: `slice(indexOf("/") + 1)` would be the whole string.
  expect(headRef("b", "weird", "origin/main")).toBe("weird");
  // A trailing slash leaves no name at all.
  expect(headRef("b", "origin/", "origin/main")).toBe("b");
  // Tracking the remote's default branch is not a pull request to look for.
  expect(headRef("b", "origin/main", "origin/main")).toBe("b");
  expect(headRef("b", undefined, "origin/main")).toBe("b");
});

test("repoFromUrl: only a pull request URL names a repository", () => {
  expect(repoFromUrl("https://github.com/org/repo/pull/7")).toEqual({ owner: "org", name: "repo" });
  // An issue URL is not a pull request URL, and neither is another host's.
  expect(repoFromUrl("https://github.com/org/repo/issues/7")).toBeUndefined();
  expect(repoFromUrl("https://gitlab.com/org/repo/pull/7")).toBeUndefined();
});

test("waitingOnYou: no readable author is still waiting on you", () => {
  // No comments object at all: the safe answer to "is this yours?" is yes.
  expect(waitingOnYou([{ isResolved: false }], "me")).toBe(1);
  expect(
    waitingOnYou([{ isResolved: false, comments: { nodes: [{ author: null }] } }], "me"),
  ).toBe(1);
  // A resolved thread is done, whoever spoke last.
  expect(waitingOnYou([{ isResolved: true }], undefined)).toBe(0);
});

// --- Our own pull request as the dashboard reads it ------------------------------------------

test("prSummary reads the pull request and counts the threads still waiting on you", async () => {
  const repo = "/repos/summary-threads";
  const shell = ghShell({
    repo,
    prs: [pr()],
    details: {
      data: {
        viewer: { login: "me" },
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false, comments: { nodes: [{ author: { login: "reviewer" } }] } },
                { isResolved: false, comments: { nodes: [{ author: { login: "me" } }] } },
                { isResolved: true, comments: { nodes: [{ author: { login: "reviewer" } }] } },
              ],
            },
          },
        },
      },
    },
  });
  expect(await runWithShell(shell, prSummary(change(), repo))).toEqual({
    number: 7,
    unresolved: 1,
    checks: "ok",
  });
});

test("prSummary says nothing when there is no worktree or no pull request", async () => {
  const noWt = "/repos/summary-nowt";
  expect(await runWithShell(ghShell({ repo: noWt, noWorktree: true }), prSummary(change(), noWt)))
    .toEqual({ unresolved: 0, checks: "none" });

  const noPr = "/repos/summary-nopr";
  expect(await runWithShell(ghShell({ repo: noPr, prs: [] }), prSummary(change(), noPr))).toEqual({
    unresolved: 0,
    checks: "none",
  });
});

test("prSummary: a merged pull request is green and waiting on nobody", async () => {
  const repo = "/repos/summary-merged";
  const shell = ghShell({
    repo,
    prs: [pr({ state: "MERGED", statusCheckRollup: [{ conclusion: "FAILURE" }] })],
  });
  expect(await runWithShell(shell, prSummary(change(), repo))).toEqual({
    number: 7,
    unresolved: 0,
    checks: "ok",
  });
});

test("prSummary colours the dot by the checks and zeroes a closed pull request's threads", async () => {
  const failing = "/repos/summary-failing";
  expect(
    await runWithShell(
      ghShell({ repo: failing, prs: [pr({ statusCheckRollup: [{ conclusion: "FAILURE" }, { state: "PENDING" }] })] }),
      prSummary(change(), failing),
    ),
  ).toMatchObject({ checks: "error" });

  const closed = "/repos/summary-closed";
  expect(
    await runWithShell(
      ghShell({ repo: closed, prs: [pr({ state: "CLOSED", reviewDecision: "CHANGES_REQUESTED" })] }),
      prSummary(change(), closed),
    ),
  ).toEqual({ number: 7, unresolved: 0, checks: "ok" });
});

test("prSummary: a draft with no checks is pending, not green", async () => {
  const repo = "/repos/summary-draft";
  const shell = ghShell({ repo, prs: [pr({ isDraft: true, statusCheckRollup: [] })] });
  expect(await runWithShell(shell, prSummary(change(), repo))).toMatchObject({ checks: "pending" });
});

test("prSummary: a gh failure is no answer, not a red card", async () => {
  const repo = "/repos/summary-boom";
  const shell = ghShell({ repo, prListCode: 1, prListStderr: "gh: not logged in\nmore" });
  // The failure is converted to "nothing", so the overview says nothing rather than going red.
  expect(await runWithShell(shell, prSummary(change(), repo))).toEqual({
    unresolved: 0,
    checks: "none",
  });
});

test("prItem: a gh error is the row, using only the first line of stderr", async () => {
  const repo = "/repos/item-error";
  const shell = ghShell({ repo, prListCode: 1, prListStderr: "gh: not logged in\nmore noise" });
  const { item } = await runWithShell(shell, prItem(change(), repo));
  expect(item).toMatchObject({ label: "pull request", detail: "gh: not logged in", state: "error" });
});

test("prItem: no worktree and no pull request are different rows", async () => {
  const noWt = "/repos/item-nowt";
  const absent = await runWithShell(ghShell({ repo: noWt, noWorktree: true }), prItem(change(), noWt));
  expect(absent.item).toMatchObject({ detail: "no worktree", state: "none" });

  const none = "/repos/item-nopr";
  const { item } = await runWithShell(ghShell({ repo: none, prs: [] }), prItem(change(), none));
  expect(item.label).toBe("no pull request");
  // The action carries the repository back, which is what the create route is asked with.
  expect(item.actions).toEqual([{ id: "create", label: "Push & create PR", arg: none }]);
});

test("prItem: a draft says so and its open threads colour the detail", async () => {
  const repo = "/repos/item-draft";
  const shell = ghShell({
    repo,
    prs: [pr({ isDraft: true, reviewDecision: "APPROVED" })],
    details: {
      data: {
        viewer: { login: "me" },
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: "them" } }] } }],
            },
          },
        },
      },
    },
  });
  const { item } = await runWithShell(shell, prItem(change(), repo));
  expect(item.detail).toBe("draft · 1 unresolved comment · approved");
  expect(item.detailTone).toBe("warn");
});

test("prItem: a merged pull request is settled and says where the branch was pushed", async () => {
  const repo = "/repos/item-merged";
  const shell = ghShell({
    repo,
    branch: "local-name",
    upstream: "origin/pushed-name",
    prs: [pr({ state: "MERGED" })],
  });
  const { item } = await runWithShell(shell, prItem(change({ branch: "local-name" }), repo));
  expect(item).toMatchObject({
    label: "#7 Do the thing",
    state: "ok",
    detail: "merged · pushed as pushed-name",
  });
});

test("prItem: a stack position is the last thing said", async () => {
  const repo = "/repos/item-stack";
  const shell = ghShell({
    repo,
    prs: [pr({ reviewDecision: "APPROVED" })],
    details: {
      data: {
        viewer: { login: "me" },
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [] },
            stack: { number: 5, size: 3 },
            stackEntry: { position: 2 },
          },
        },
      },
    },
  });
  const { item } = await runWithShell(shell, prItem(change(), repo));
  expect(item.detail).toBe("ready to merge · 2 of 3 in stack #5");
});

test("prItem: a repository without the stacks preview still gets its comment count", async () => {
  const repo = "/repos/item-nostack";
  const shell = ghShell({
    repo,
    stackQueryFails: true,
    prs: [pr({ reviewDecision: "REVIEW_REQUIRED" })],
    details: {
      data: {
        viewer: { login: "me" },
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: "them" } }] } }],
            },
          },
        },
      },
    },
  });
  const { item } = await runWithShell(shell, prItem(change(), repo));
  // The query was retried without the stack fields rather than losing the thread count.
  expect(item.detail).toBe("1 unresolved comment · review required");
});

// --- Merge readiness and merging --------------------------------------------------------------

test("mergeReadiness names every reason a pull request is not ready", async () => {
  const check = async (
    name: string,
    opts: Omit<GhShellOptions, "repo">,
    expected: MergeReadiness,
  ): Promise<void> => {
    const repo = `/repos/${name}`;
    const shell = ghShell({ repo, ...opts });
    expect(await runWithShell(shell, mergeReadiness(change(), repo))).toEqual(expected);
  };

  await check("mr-nowt", { noWorktree: true }, { ready: false, reason: "mr-nowt: no worktree" });
  await check("mr-nopr", { prs: [] }, { ready: false, reason: "mr-nopr: no pull request" });
  await check("mr-merged", { prs: [pr({ state: "MERGED" })] }, { ready: true, merged: true });
  await check("mr-closed", { prs: [pr({ state: "CLOSED" })] }, {
    ready: false,
    reason: "mr-closed: pull request is closed",
  });
  await check("mr-draft", { prs: [pr({ isDraft: true })] }, {
    ready: false,
    reason: "mr-draft: pull request is a draft",
  });
  await check("mr-conflict", { prs: [pr({ mergeable: "CONFLICTING" })] }, {
    ready: false,
    reason: "mr-conflict: conflicts",
  });
  await check("mr-review", { prs: [pr({ reviewDecision: "REVIEW_REQUIRED" })] }, {
    ready: false,
    reason: "mr-review: not approved (review required)",
  });
  // A decision GitHub spells with underscores reads as words.
  await check("mr-changes", { prs: [pr({ reviewDecision: "CHANGES_REQUESTED" })] }, {
    ready: false,
    reason: "mr-changes: not approved (changes requested)",
  });
  await check("mr-approved", { prs: [pr()] }, { ready: true, merged: false, number: 7 });
});

test("mergePr: a plain pull request is squash-merged through gh", async () => {
  const repo = "/repos/merge-plain";
  // No stack: `gh repo view` answers with nothing, so the ordinary merge endpoint is used.
  const shell = ghShell({ repo, gh: (line) => (line.startsWith("gh repo view") ? "" : undefined) });
  expect(await runWithShell(shell, mergePr(change(), repo, 7))).toBeUndefined();
  expect(shell.calls.map((c) => c.cmd.join(" "))).toContain("gh pr merge 7 --squash");
});

test("mergePr: a stacked pull request goes through the asynchronous merge", async () => {
  const repo = "/repos/merge-2";
  const shell = ghShell({
    repo,
    gh: (line) => {
      if (line.startsWith("gh repo view")) return "org/repo";
      if (line.startsWith("gh api repos/org/repo/pulls/7")) return JSON.stringify({ stack: { number: 5 } });
      if (line.includes("merge-async")) return JSON.stringify({ status: "enqueued" });
      return undefined;
    },
  });
  // Enqueued is an ending with a note: the queue owns the merge from here.
  expect(await runWithShell(shell, mergePr(change(), repo, 7))).toBe(
    "merge-2 #7: added to the merge queue",
  );
});

test("mergePr: an immediately merged stack reports no note", async () => {
  const repo = "/repos/merge-3";
  const shell = ghShell({
    repo,
    gh: (line) => {
      if (line.startsWith("gh repo view")) return "org/repo";
      if (line.startsWith("gh api repos/org/repo/pulls/7")) return JSON.stringify({ stack: { number: 5 } });
      if (line.includes("merge-async")) return JSON.stringify({ status: "merged" });
      return undefined;
    },
  });
  expect(await runWithShell(shell, mergePr(change(), repo, 7))).toBeUndefined();
});

test("mergePr: a stack that cannot start the merge fails with what GitHub said", async () => {
  const repo = "/repos/merge-4";
  const shell = ghShell({
    repo,
    gh: (line) => {
      if (line.startsWith("gh repo view")) return "org/repo";
      if (line.startsWith("gh api repos/org/repo/pulls/7")) return JSON.stringify({ stack: { number: 5 } });
      if (line.includes("merge-async")) return { code: 1, stdout: "{}", stderr: "refused" };
      return undefined;
    },
  });
  const either = await runEither(shell, mergePr(change(), repo, 7));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) expect(either.left.message).toContain("could not start the merge of #7");
});

test("mergePr: no worktree is a bad request before any merge is attempted", async () => {
  const repo = "/repos/merge-nowt";
  const either = await runEither(ghShell({ repo, noWorktree: true }), mergePr(change(), repo, 7));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isLeft(either)) expect(either.left._tag).toBe("BadRequestError");
});

// --- Creating a pull request ------------------------------------------------------------------

test("createPr pushes and opens against the remote's default branch", async () => {
  const repo = "/repos/create-plain";
  const shell = ghShell({ repo });
  await runWithShell(shell, createPr(change(), repo));
  const lines = shell.calls.map((c) => c.cmd.join(" "));
  expect(lines).toContain("git push -u origin feature");
  // Nothing to say about the base: the change's branch starts from the default one.
  expect(lines).toContain("gh pr create --fill");
});

test("createPr targets the base branch and ties the new pull request into its stack", async () => {
  const repo = "/repos/create-stack";
  const shell = ghShell({
    repo,
    gh: (line) => {
      if (line.startsWith("gh repo view")) return "org/repo";
      if (line === "gh pr view --json number -q .number") return "42";
      if (line === "gh pr list --head PROJ-0 --state open --json number --limit 1") {
        return JSON.stringify([{ number: 7 }]);
      }
      if (line.startsWith("gh api repos/org/repo/pulls/7")) return JSON.stringify({ stack: { number: 5 } });
      return undefined;
    },
  });
  await runWithShell(shell, createPr(change({ base: { [repo]: "origin/PROJ-0" } }), repo));
  const lines = shell.calls.map((c) => c.cmd.join(" "));
  // A change stacked on another branch must open against it, not against main.
  expect(lines).toContain("gh pr create --fill --base PROJ-0");
  // And the new pull request joins the stack the base branch already belongs to.
  expect(lines).toContain(
    "gh api -X POST -H X-GitHub-Api-Version: 2026-03-10 repos/org/repo/stacks/5/add -F pull_requests[]=42",
  );
});

test("createPr: no worktree and a failed push both stop before a pull request exists", async () => {
  const noWt = "/repos/create-nowt";
  const either = await runEither(ghShell({ repo: noWt, noWorktree: true }), createPr(change(), noWt));
  expect(Either.isLeft(either)).toBe(true);

  const repo = "/repos/create-nopush";
  const shell = ghShell({
    repo,
    gh: (line) => (line === "git push -u origin feature" ? { code: 1, stderr: "rejected" } : undefined),
  });
  const failed = await runEither(shell, createPr(change(), repo));
  expect(Either.isLeft(failed)).toBe(true);
  if (Either.isLeft(failed)) expect(failed.left._tag).toBe("CliError");
});

// --- github-issues: pure parsing --------------------------------------------------------------

test("repoFromRemote reads the shapes a git remote comes in", () => {
  expect(repoFromRemote("https://github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(repoFromRemote("git@github.com:owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(repoFromRemote("ssh://git@github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  // Not GitHub, or nothing at all: no repository to name.
  expect(repoFromRemote("https://gitlab.com/owner/name.git")).toBeUndefined();
  expect(repoFromRemote("")).toBeUndefined();
});

// --- github-issues: reads through the Shell service -------------------------------------------

test("nameWithOwner reads the origin URL and caches the answer", async () => {
  // The execution count lives in the effect, not in `fakeShell.calls`: fakeShell records a call
  // when the work effect is built, and the cache only suppresses running it on the second ask.
  const runs: string[] = [];
  const shell: FakeShell = {
    calls: [],
    run: (cmd, opts) => {
      shell.calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      return Effect.sync(() => {
        runs.push(cmd.join(" "));
        return { code: 0, stdout: "git@github.com:owner/name.git", stderr: "" };
      });
    },
  };
  expect(await runExtension(shell, nameWithOwner("/r/nwo-one"))).toBe("owner/name");
  expect(await runExtension(shell, nameWithOwner("/r/nwo-one"))).toBe("owner/name");
  // One subprocess for the dashboard's repeated asks about the same repository.
  expect(runs).toEqual(["git remote get-url origin"]);
});

test("nameWithOwner says nothing for a repository with no GitHub origin", async () => {
  const noRemote = fakeShell({ "git remote get-url origin": { code: 128, stderr: "no such remote" } });
  expect(await runExtension(noRemote, nameWithOwner("/r/nwo-two"))).toBeUndefined();

  const notGithub = fakeShell({ "git remote get-url origin": "https://gitlab.com/owner/name.git\n" });
  expect(await runExtension(notGithub, nameWithOwner("/r/nwo-three"))).toBeUndefined();
});

test("listIssues flattens gh's answer and names the repository", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue list -R owner/name --state open --limit 100 --json number,title,state,url,assignees,labels":
      JSON.stringify([
        {
          number: 3,
          title: "Third",
          state: "OPEN",
          url: "u3",
          assignees: [{ login: "ada" }, { login: "" }],
          labels: [{ name: "bug" }, {}],
        },
        { number: 1, title: "First", state: "OPEN" },
      ]),
  });
  const listing = await runExtension(shell, listIssues("/r/list-one"));
  expect(listing.repository).toBe("owner/name");
  // Empty logins and unnamed labels are dropped rather than shown as blanks.
  expect(listing.issues).toEqual([
    { number: 3, title: "Third", state: "OPEN", url: "u3", assignees: ["ada"], labels: ["bug"] },
    { number: 1, title: "First", state: "OPEN", url: undefined, assignees: [], labels: [] },
  ]);
});

test("listIssues: a repository not on GitHub has none, and gh is never asked", async () => {
  const shell = fakeShell({ "git remote get-url origin": { code: 1, stderr: "nope" } });
  expect(await runExtension(shell, listIssues("/r/list-nogh"))).toEqual({ issues: [] });
  expect(shell.calls.some((c) => c.cmd[0] === "gh")).toBe(false);
});

test("listIssues: a failing or unreadable gh answer is no issues, not a failure", async () => {
  const failed = fakeShell({
    "git remote get-url origin": "https://github.com/owner/fail.git\n",
    "gh issue list -R owner/fail --state open --limit 100 --json number,title,state,url,assignees,labels":
      { code: 1, stderr: "boom" },
  });
  expect((await runExtension(failed, listIssues("/r/list-fail"))).issues).toEqual([]);

  const junk = fakeShell({
    "git remote get-url origin": "https://github.com/owner/junk.git\n",
    "gh issue list -R owner/junk --state open --limit 100 --json number,title,state,url,assignees,labels":
      "not json",
  });
  expect((await runExtension(junk, listIssues("/r/list-junk"))).issues).toEqual([]);
});

test("viewIssue flattens one issue and treats a missing or null answer as nothing", async () => {
  const shell = fakeShell({
    "gh issue view 5 -R owner/name --json number,title,state,url,assignees,labels": JSON.stringify({
      number: 5,
      title: "Five",
      state: "CLOSED",
      assignees: [{ login: "ada" }],
      labels: [{ name: "done" }],
    }),
  });
  expect(await runExtension(shell, viewIssue("owner/name", 5))).toEqual({
    number: 5,
    title: "Five",
    state: "CLOSED",
    url: undefined,
    assignees: ["ada"],
    labels: ["done"],
  });

  const missing = fakeShell({
    "gh issue view 9 -R owner/name --json number,title,state,url,assignees,labels":
      { code: 1, stderr: "not found" },
  });
  expect(await runExtension(missing, viewIssue("owner/name", 9))).toBeUndefined();

  const nulled = fakeShell({
    "gh issue view 9 -R owner/name --json number,title,state,url,assignees,labels": "null",
  });
  expect(await runExtension(nulled, viewIssue("owner/name", 9))).toBeUndefined();
});

// --- github-issues: creating and closing ------------------------------------------------------

test("createIssue returns the issue it just made, read back by number", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue create -R owner/name -t New thing -b Some body":
      "https://github.com/owner/name/issues/5\n",
    "gh issue view 5 -R owner/name --json number,title,state,url,assignees,labels": JSON.stringify({
      number: 5,
      title: "New thing",
      state: "OPEN",
      assignees: [],
      labels: [],
    }),
  });
  expect(await runExtension(shell, createIssue("/r/create-body", "New thing", "Some body"))).toEqual({
    repository: "owner/name",
    issue: { number: 5, title: "New thing", state: "OPEN", url: undefined, assignees: [], labels: [] },
  });
});

test("createIssue omits a blank body and falls back when the new issue cannot be read back", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue create -R owner/name -t Title": "https://github.com/owner/name/issues/6\n",
    "gh issue view 6 -R owner/name --json number,title,state,url,assignees,labels":
      { code: 1, stderr: "not yet" },
  });
  const created = await runExtension(shell, createIssue("/r/create-blank", "Title", "   "));
  // The read-back failed, so the fallback describes what was asked for rather than losing it.
  expect(created.issue).toEqual({
    number: 6,
    title: "Title",
    state: "open",
    assignees: [],
    labels: [],
  });
  // Whitespace is not a body: no `-b` was passed.
  expect(shell.calls.some((c) => c.cmd.join(" ") === "gh issue create -R owner/name -t Title -b    ")).toBe(false);
});

test("createIssue: no GitHub remote, a failing gh and an unreadable URL are bad requests", async () => {
  const noRemote = fakeShell({ "git remote get-url origin": { code: 1, stderr: "none" } });
  const missing = await runExtensionEither(noRemote, createIssue("/r/create-nogh", "T", undefined));
  expect(Either.isLeft(missing) && missing.left._tag).toBe("BadRequestError");

  const failed = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue create -R owner/name -t T": { code: 1, stderr: "no permission" },
  });
  const refused = await runExtensionEither(failed, createIssue("/r/create-fail", "T", undefined));
  expect(Either.isLeft(refused) && refused.left._tag).toBe("BadRequestError");
  if (Either.isLeft(refused)) expect(refused.left.message).toContain("no permission");

  const unreadable = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue create -R owner/name -t T": "created but no url",
  });
  const noNumber = await runExtensionEither(unreadable, createIssue("/r/create-nonum", "T", undefined));
  expect(Either.isLeft(noNumber)).toBe(true);
  if (Either.isLeft(noNumber)) expect(noNumber.left.message).toContain("could not read the new issue's number");
});

test("completing a change closes its issue with a word about where the work landed", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue close 7 -R owner/name -c Completed in change D": { code: 0, stdout: "" },
  });
  const c = change({ id: "D", extensions: { "github-issues": { repo: "/r/close", number: 7 } } });
  expect(await runExtension(shell, githubIssues.completionSteps![0]!.run(c))).toBe(
    "closed owner/name#7",
  );
  expect(
    shell.calls.some((call) => call.cmd.join(" ") === "gh issue close 7 -R owner/name -c Completed in change D"),
  ).toBe(true);
});

test("completing a change without a GitHub remote says so, and a failing close is a bad request", async () => {
  const noRemote = fakeShell({ "git remote get-url origin": { code: 1, stderr: "none" } });
  const c1 = change({ id: "D", extensions: { "github-issues": { repo: "/r/close-nogh", number: 7 } } });
  expect(await runExtension(noRemote, githubIssues.completionSteps![0]!.run(c1))).toBe(
    "not a GitHub repository: /r/close-nogh",
  );

  const failed = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue close 7 -R owner/name -c Completed in change D": { code: 1, stderr: "refused" },
  });
  const c2 = change({ id: "D", extensions: { "github-issues": { repo: "/r/close-fail", number: 7 } } });
  const either = await runExtensionEither(failed, githubIssues.completionSteps![0]!.run(c2));
  expect(Either.isLeft(either) && either.left._tag).toBe("BadRequestError");
});

test("completing a change with no linked issue does nothing at all", async () => {
  const shell = fakeShell();
  expect(await runExtension(shell, githubIssues.completionSteps![0]!.run(change()))).toBeUndefined();
  expect(shell.calls).toEqual([]);
});

test("the completion plan names the issue without asking gh", () => {
  const world = { config, workspace: workspaceById(undefined) };
  expect(githubIssues.completionSteps![0]!.plan(withRef("/r/thing", 9), world)?.label).toBe(
    "close thing#9",
  );
  expect(githubIssues.completionSteps![0]!.plan(change(), world)).toBeUndefined();
});

// --- github-issues: the card, titles and description ------------------------------------------

const cardStatus = githubIssues.cards![0]!.status!;

test("the card says 'none' for a change with no issue linked", async () => {
  expect(await runExtension(fakeShell(), cardStatus(change()))).toEqual({
    integration: "github-issues",
    title: "GitHub issues",
    state: "none",
    summary: "no issue linked",
    items: [],
  });
});

test("the card: a repository not on GitHub is an error, not a missing issue", async () => {
  const shell = fakeShell({ "git remote get-url origin": { code: 1, stderr: "no remote" } });
  const widget = await runExtension(shell, cardStatus(withRef("/r/card-nogh", 7)));
  expect(widget).toMatchObject({ state: "error", summary: "not a GitHub repository", items: [] });
});

test("the card: an issue that is not there is named as not found", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue view 7 -R owner/name --json number,title,state,url,assignees,labels":
      { code: 1, stderr: "no issue" },
  });
  const widget = await runExtension(shell, cardStatus(withRef("/r/card-nf", 7)));
  expect(widget).toMatchObject({ state: "error", summary: "issue not found: #7", items: [] });
});

test("the card: one row for the issue, coloured and detailed by its state", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue view 7 -R owner/name --json number,title,state,url,assignees,labels": JSON.stringify({
      number: 7,
      title: "Fix the thing",
      state: "closed",
      url: "https://github.com/owner/name/issues/7",
      assignees: [{ login: "ada" }],
      labels: [{ name: "bug" }],
    }),
  });
  const widget = await runExtension(shell, cardStatus(withRef("/r/card-ok", 7)));
  expect(widget.state).toBe("ok");
  expect(widget.summary).toBe("closed");
  expect(widget.items).toEqual([
    {
      label: "owner/name#7 Fix the thing",
      detail: "closed · ada · bug",
      url: "https://github.com/owner/name/issues/7",
      state: "ok",
    },
  ]);
});

test("the title source applies only to a change with a linked issue", () => {
  const applies = githubIssues.titleSources![0]!.applies;
  expect(applies(withRef("/r/thing", 1))).toBe(true);
  expect(applies(change())).toBe(false);
});

test("the title source names only the changes with a readable linked issue", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue view 7 -R owner/name --json number,title,state,url,assignees,labels": JSON.stringify({
      number: 7,
      title: "From the issue",
      state: "OPEN",
    }),
    "gh issue view 8 -R owner/name --json number,title,state,url,assignees,labels":
      { code: 1, stderr: "gone" },
  });
  const titles = await runExtension(
    shell,
    githubIssues.titleSources![0]!.lookup([
      withRefId("A", "/r/titles", 7),
      withRefId("B", "/r/titles", 8),
      change({ id: "C" }),
    ]),
  );
  // B's lookup failed and C has no issue: the stored title stands for them.
  expect([...titles]).toEqual([["A", "From the issue"]]);
});

test("the description heading names the issue and its title when there is one", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue view 7 -R owner/name --json number,title,state,url,assignees,labels": JSON.stringify({
      number: 7,
      title: "Fix the thing",
      state: "OPEN",
    }),
  });
  expect(
    await runExtension(shell, githubIssues.descriptionSections![0]!.heading(withRef("/r/desc", 7))),
  ).toBe("owner/name#7 - Fix the thing");
  // No issue linked: nothing to head a section with.
  expect(
    await runExtension(fakeShell(), githubIssues.descriptionSections![0]!.heading(change())),
  ).toBeUndefined();
});

test("the description heading keeps the reference when the issue or repository cannot be read", async () => {
  const unreadable = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue view 7 -R owner/name --json number,title,state,url,assignees,labels":
      { code: 1, stderr: "gone" },
  });
  expect(
    await runExtension(unreadable, githubIssues.descriptionSections![0]!.heading(withRef("/r/desc2", 7))),
  ).toBe("owner/name#7");

  const notGithub = fakeShell({ "git remote get-url origin": { code: 1, stderr: "none" } });
  expect(
    await runExtension(notGithub, githubIssues.descriptionSections![0]!.heading(withRef("/r/desc3", 7))),
  ).toBeUndefined();
});

// --- github-issues: the wizard routes ---------------------------------------------------------

const getIssues = githubIssues.routes!.find((r) => r.method === "GET")!;
const postIssues = githubIssues.routes!.find((r) => r.method === "POST")!;

test("the GET route lists a repository's issues", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue list -R owner/name --state open --limit 100 --json number,title,state,url,assignees,labels":
      JSON.stringify([{ number: 1, title: "One", state: "OPEN" }]),
  });
  const res = await runExtension(
    shell,
    getIssues.handler(new Request("http://x/issues?repo=/r/route-get")),
  );
  expect(await res.json()).toEqual({
    repository: "owner/name",
    issues: [{ number: 1, title: "One", state: "OPEN", url: undefined, assignees: [], labels: [] }],
  });
});

test("the POST route creates an issue and answers 201", async () => {
  const shell = fakeShell({
    "git remote get-url origin": "https://github.com/owner/name.git\n",
    "gh issue create -R owner/name -t New title -b Body": "https://github.com/owner/name/issues/11\n",
    "gh issue view 11 -R owner/name --json number,title,state,url,assignees,labels": JSON.stringify({
      number: 11,
      title: "New title",
      state: "OPEN",
    }),
  });
  const res = await runExtension(
    shell,
    postIssues.handler(
      new Request("http://x/issues", {
        method: "POST",
        body: JSON.stringify({ repo: "/r/route-post", title: " New title ", description: "Body" }),
      }),
    ),
  );
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    repository: "owner/name",
    issue: { number: 11, title: "New title", state: "OPEN", url: undefined, assignees: [], labels: [] },
  });
});

test("the POST route refuses a missing repository, a blank title and an unreadable body", async () => {
  const missing = await runExtensionEither(
    fakeShell(),
    postIssues.handler(
      new Request("http://x/issues", { method: "POST", body: JSON.stringify({ repo: "", title: "x" }) }),
    ),
  );
  expect(Either.isLeft(missing) && missing.left._tag).toBe("BadRequestError");

  const blank = await runExtensionEither(
    fakeShell(),
    postIssues.handler(
      new Request("http://x/issues", { method: "POST", body: JSON.stringify({ repo: "/r/x", title: "   " }) }),
    ),
  );
  expect(Either.isLeft(blank) && blank.left._tag).toBe("BadRequestError");

  // A body that is not JSON at all falls back to "no fields", which is the same bad request.
  const junk = await runExtensionEither(
    fakeShell(),
    postIssues.handler(new Request("http://x/issues", { method: "POST", body: "not json" })),
  );
  expect(Either.isLeft(junk) && junk.left._tag).toBe("BadRequestError");
});
