import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision, integrations } from "../src/integrations/index.ts";
import {
  describe,
  findWorktree,
  setRepos,
  unsafeIn,
  openers,
  parseWorktrees,
  parseStatus,
  type WtEntry,
} from "../src/integrations/git.ts";
import { isMac } from "../src/platform.ts";
import {
  averageDuration,
  folderFor,
  refsFor,
  runState,
  versionInLines,
} from "../src/integrations/azure.ts";
import { readiness, repoFromUrl, headRef, waitingOnYou } from "../src/integrations/github.ts";
import { groupChecks } from "../src/integrations/checks.ts";
import { stackRequest, describeStack, outcomeOf, pollResult } from "../src/integrations/stacks.ts";
import { verdict } from "../src/complete.ts";
import { describeChange } from "../src/description.ts";
import { windowLabel } from "../src/web/windowLabel.ts";
import type { Change, Integration } from "../src/types.ts";

/**
 * A changes root of its own, because some of what is tested here writes one.
 *
 * `setRepos` used to refuse an empty list before it wrote anything, so this file never touched
 * the disk and never said where it would. Now that a change may be emptied, it does — and without
 * this it writes into whatever changes root the machine is configured with, which on the author's
 * machine was the real one.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-provision-"));
  process.env.IWE_ROOT = tmp;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const change: Change = {
  id: "PROJ-1",
  branch: "PROJ-1-thing",
  repos: [],
  createdAt: new Date().toISOString(),
};

test("provisioning reports every component and survives a failing one", async () => {
  const calls: string[] = [];
  const stub = (name: string, fail?: boolean): Integration => ({
    name,
    title: name,
    status: async () => ({ integration: name, title: name, state: "none", summary: "", items: [] }),
    provision: async () => {
      calls.push(name);
      if (fail) throw new Error(`${name} exploded`);
    },
  });
  const original = { ...integrations };
  for (const key of Object.keys(integrations)) delete integrations[key];
  integrations.one = stub("one", true);
  integrations.two = stub("two");

  const results = await provision(change);
  expect(calls).toEqual(["one", "two"]); // a failure must not stop the components after it
  expect(results).toEqual([
    { integration: "one", ok: false, error: "one exploded" },
    { integration: "two", ok: true },
  ]);

  for (const key of Object.keys(integrations)) delete integrations[key];
  Object.assign(integrations, original);
});

test("worktree status is read from wt's own output", () => {
  const entries = JSON.parse(
    `[{"branch":"main","path":"/r","is_main":true,"working_tree":{},"remote":{"branch":"main","ahead":0,"behind":0}},
      {"branch":"PROJ-1-thing","path":"/r/.worktrees/PROJ-1-thing","working_tree":{"modified":true},
       "remote":{"branch":"PROJ-1-thing","ahead":2,"behind":1},"main_state":"diverged"}]`,
  ) as WtEntry[];

  const entry = findWorktree(entries, "PROJ-1-thing");
  expect(entry?.path).toBe("/r/.worktrees/PROJ-1-thing");
  expect(describe(entry!)).toEqual({
    detail: "uncommitted changes, 2 unpushed, 1 behind",
    state: "pending",
  });
  expect(describe(entries[0]!)).toEqual({ detail: "clean", state: "ok" });
  expect(findWorktree(entries, "absent")).toBeUndefined();
});

test("pipelines are looked up by both the merge ref and the branch", () => {
  expect(refsFor("PROJ-1-thing")).toEqual(["refs/heads/PROJ-1-thing"]);
  // Validation builds run on the merge ref, CI-triggered ones stay on the branch: both matter.
  expect(refsFor("PROJ-1-thing", 719)).toEqual([
    "refs/pull/719/merge",
    "refs/heads/PROJ-1-thing",
  ]);

  const run = (status: string, result?: string) =>
    runState({ id: 1, buildNumber: "1", status, result, sourceBranch: "x" });
  expect(run("inProgress")).toBe("pending");
  expect(run("notStarted")).toBe("pending");
  expect(run("completed", "succeeded")).toBe("ok");
  expect(run("completed", "partiallySucceeded")).toBe("warn");
  expect(run("completed", "canceled")).toBe("warn");
  expect(run("completed", "failed")).toBe("error");
});

test("pipelines are attributed to a repository by its Azure DevOps folder", () => {
  expect(folderFor("/Users/me/Repos/acme/example-api")).toBe("\\example-api");
});

test("expected build duration averages finished runs and ignores unfinished ones", () => {
  const run = (start?: string, finish?: string) => ({
    id: 1,
    buildNumber: "1",
    status: finish ? "completed" : "inProgress",
    sourceBranch: "x",
    startTime: start,
    finishTime: finish,
  });
  expect(
    averageDuration([
      run("2026-08-18T10:00:00Z", "2026-08-18T10:10:00Z"), // 10m
      run("2026-08-18T09:00:00Z", "2026-08-18T09:20:00Z"), // 20m
      run("2026-08-18T11:00:00Z"), // still running, no contribution
    ]),
  ).toBe(15 * 60 * 1000);
  expect(averageDuration([run("2026-08-18T11:00:00Z")])).toBeUndefined();
  expect(averageDuration([])).toBeUndefined();
});

test("owner and name come from the pull request url", () => {
  expect(repoFromUrl("https://github.com/owner/example-api-service/pull/720")).toEqual({
    owner: "octocat",
    name: "example-api-service",
  });
  // The directory name is not the repository name, which is why the URL is the source.
  expect(repoFromUrl("https://example.com/nope")).toBeUndefined();
});

test("a pull request says what it is waiting for", () => {
  // Open threads and the review decision are both shown: approved-with-comments is a real state.
  expect(readiness({ reviewDecision: "APPROVED" }, 1)).toEqual({
    text: "1 unresolved comment · approved",
    tone: "warn",
  });
  expect(readiness({ reviewDecision: "REVIEW_REQUIRED" }, 2)).toEqual({
    text: "2 unresolved comments · review required",
    tone: "warn",
  });

  expect(readiness({ reviewDecision: "APPROVED" })).toEqual({ text: "ready to merge", tone: "ok" });
  expect(readiness({ reviewDecision: "REVIEW_REQUIRED" })).toEqual({ text: "review required" });
  expect(readiness({ reviewDecision: null })).toEqual({ text: "review required" });
  expect(readiness({ reviewDecision: "CHANGES_REQUESTED" })).toEqual({
    text: "changes requested",
    tone: "warn",
  });
  // Conflicts outrank an approval: it cannot be merged as it stands.
  expect(readiness({ reviewDecision: "APPROVED", mergeable: "CONFLICTING" })).toEqual({
    text: "conflicts",
    tone: "error",
  });
});

test("a change completes as a whole or not at all", () => {
  const merged = { ready: true, merged: true } as const;
  const approved = (n: number) => ({ ready: true, merged: false, number: n }) as const;

  expect(
    verdict([
      { repo: "/r/a", readiness: merged },
      { repo: "/r/b", readiness: approved(7) },
    ]),
  ).toEqual({ ready: true, reasons: [], toMerge: [{ repo: "/r/b", number: 7 }] });

  // One unapproved repository blocks the whole change, and says which.
  expect(
    verdict([
      { repo: "/r/a", readiness: approved(7) },
      { repo: "/r/b", readiness: { ready: false, reason: "b: not approved (review required)" } },
    ]),
  ).toEqual({
    ready: false,
    reasons: ["b: not approved (review required)"],
    toMerge: [{ repo: "/r/a", number: 7 }],
  });

  // Everything merged by hand already: allowed, nothing left to merge.
  expect(verdict([{ repo: "/r/a", readiness: merged }])).toEqual({
    ready: true,
    reasons: [],
    toMerge: [],
  });

  // Completing removes worktrees, so work the remote never saw blocks it even when approved.
  expect(verdict([{ repo: "/r/a", readiness: approved(7), unsafe: { text: "uncommitted changes" } }])).toEqual(
    { ready: false, reasons: ["a: uncommitted changes"], toMerge: [{ repo: "/r/a", number: 7 }] },
  );
});

test("what a worktree removal would destroy", () => {
  const entry = (over: Partial<WtEntry>): WtEntry => ({
    branch: "b",
    path: "/p",
    remote: { name: "origin", branch: "b", ahead: 0, behind: 0 },
    main_state: "integrated",
    ...over,
  });

  expect(unsafeIn(entry({}))).toBeUndefined();
  expect(unsafeIn(undefined)).toBeUndefined();
  expect(unsafeIn(entry({ working_tree: { modified: true } }))?.kind).toBe("dirty");
  expect(unsafeIn(entry({ working_tree: { untracked: true } }))?.kind).toBe("dirty");
  expect(unsafeIn(entry({ remote: { branch: "b", ahead: 2 } }))?.kind).toBe("unpushed");
  // Never pushed at all: no upstream to be ahead of, but the commits vanish with the branch.
  expect(unsafeIn(entry({ remote: null, main_state: "ahead" }))?.kind).toBe("unpushed");
  // Never pushed, but main already has the work: nothing to lose.
  expect(unsafeIn(entry({ remote: null, main_state: "integrated" }))).toBeUndefined();
});

test("blank entries are not repositories, and a repository is not listed twice", async () => {
  // The list arrives from a browser: whitespace is nothing, and adding the same path twice is a
  // double click rather than two repositories.
  const emptied = await setRepos({ ...change, repos: [] }, ["  ", ""]);
  expect((emptied as { change: Change }).change.repos).toEqual([]);

  // Listed twice, and already there: nothing is created, so this needs no repository on disk.
  const once = await setRepos({ ...change, repos: ["/r/a"] }, ["/r/a", "/r/a"]);
  expect((once as { change: Change }).change.repos).toEqual(["/r/a"]);
});

test("the artifact version is read from the build log lines", () => {
  expect(versionInLines(["...", "2026-08-18T11:53:21Z Version is: '20260818_115321_16daedb'"])).toBe(
    "20260818_115321_16daedb",
  );
  expect(versionInLines(["pushing manifest for registry/app:20260818.4"])).toBe("20260818.4");
  expect(versionInLines(["Built and pushed image as registry/app:20260818.4"])).toBe("20260818.4");
  // "Version      : 1.0.0" is the agent's own banner, not an artifact version.
  expect(versionInLines(["2026-08-18T11:40:02Z Version      : 1.0.0", "git version 2.52.0"])).toBeUndefined();
});

test("the pull request description lists the ticket and one link per repository", () => {
  // The formatting, without the CLIs: heading, then one entry per repository.
  const text = describeChange("PROJ-1627", "Anonymize customers", [
    "https://github.com/org/a/pull/1",
    "b-without-a-pr",
  ]);
  expect(text).toBe(
    "PROJ-1627 - Anonymize customers\nhttps://github.com/org/a/pull/1\nb-without-a-pr\n",
  );
  expect(describeChange(undefined, undefined, ["a"])).toBe("\na\n");
});

test("a pipeline's dot follows its newest run, not its history", () => {
  const run = (id: number, result: string) =>
    ({ id, buildNumber: String(id), status: "completed", result, sourceBranch: "x" }) as const;
  // Newest first, as the runs list is sorted.
  expect(runState(run(3, "succeeded"))).toBe("ok");
  expect(runState(run(2, "failed"))).toBe("error");
  // The pipeline row takes the first (newest) child; an older failure keeps its own red dot.
  const children = [run(3, "succeeded"), run(2, "failed")].map((r) => runState(r));
  expect(children[0]).toBe("ok");
});

test("pull request checks are grouped by build, so one build is one row", () => {
  const check = (name: string, bucket: string) => ({ name, bucket, state: bucket, link: `u/${name}` });
  const items = groupChecks([
    check("owner.frontend-app", "pass"),
    check("owner.frontend-app (CI App @scope/one-app)", "fail"),
    check("owner.frontend-app (CI Affected Build)", "pending"),
    check("sonarqube", "pass"),
  ]);
  expect(items.map((i) => i.label)).toEqual(["owner.frontend-app", "sonarqube"]);

  const [turbo, sonar] = items;
  // A failure anywhere in the group colours the group, and the counts say what is going on.
  expect(turbo!.state).toBe("error");
  expect(turbo!.detail).toBe("3 checks · 1 failing · 1 running");
  // The check named exactly like the group is the build itself, not one of its jobs.
  expect(turbo!.children!.map((c) => c.label)).toEqual([
    "overall",
    "CI App @scope/one-app",
    "CI Affected Build",
  ]);

  // A lone check needs no children, and keeps its own link.
  expect(sonar!.children).toBeUndefined();
  expect(sonar!.url).toBe("u/sonarqube");
});

test("a terminal window is labelled by where it is, or what you named it", () => {
  const w = (over: Partial<Parameters<typeof windowLabel>[0]>) =>
    windowLabel({
      index: 0,
      name: "zsh",
      command: "zsh",
      active: true,
      activity: false,
      directory: "example-api",
      named: false,
      ...over,
    });
  // tmux's default name is the command, which says less than the directory does.
  expect(w({})).toBe("example-api");
  expect(w({ command: "vim" })).toBe("example-api - (vim)");
  // A window you named yourself keeps its name, wherever it wandered off to.
  expect(w({ name: "deploy", command: "gradle", named: true })).toBe("deploy - (gradle)");
  // An agent is `node` to tmux, which says nothing; what it says about itself replaces that.
  expect(w({ command: "node", agent: "working" })).toBe("example-api - (pi working)");
  expect(w({ command: "node", agent: "waiting" })).toBe("example-api - (pi waiting)");
  // Nothing is repeated: a window named after what runs in it says it once.
  expect(w({ name: "logs", command: "logs", directory: "x", named: true })).toBe("logs");
})

test("a stacked pull request joins the stack below it, or starts one", () => {
  // The pull request below already belongs to a stack: append to it, nothing else.
  expect(stackRequest("org/repo", 161, 162, 163)).toEqual([
    "repos/org/repo/stacks/163/add",
    "-F",
    "pull_requests[]=162",
  ]);
  // It does not: the two of them become a stack, bottom first.
  expect(stackRequest("org/repo", 161, 162)).toEqual([
    "repos/org/repo/stacks",
    "-F",
    "pull_requests[]=161",
    "-F",
    "pull_requests[]=162",
  ]);
});

test("a pull request says where it sits in its stack", () => {
  expect(describeStack({ number: 163, size: 2, position: 1 })).toBe("1 of 2 in stack #163");
});

test("opening a repository uses the platform's own launcher", () => {
  const command = (id: string) => openers.find((o) => o.id === id)!.command("/w/repo");
  if (isMac) {
    // No -n: the running IntelliJ gets the project and places it as you have configured.
    expect(command("open-idea")).toEqual(["open", "-a", "IntelliJ IDEA", "/w/repo"]);
    expect(command("open-finder")).toEqual(["open", "/w/repo"]);
  } else {
    // Linux has no application registry: the desktop's file manager via xdg-open, IntelliJ only
    // when its launcher script is installed.
    expect(command("open-files")).toEqual(["xdg-open", "/w/repo"]);
    expect(command("open-idea")).toEqual(["idea", "/w/repo"]);
  }
});

test("a worktree's state is read from git's own porcelain output", () => {
  const worktrees = parseWorktrees(
    [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /changes/PROJ-1/repo",
      "HEAD bbb",
      "branch refs/heads/PROJ-1-thing",
      "",
      "worktree /detached",
      "HEAD ccc",
      "detached",
    ].join("\n"),
  );
  // A detached worktree belongs to no branch and so to no change.
  expect(worktrees).toEqual([
    { path: "/repo", branch: "main" },
    { path: "/changes/PROJ-1/repo", branch: "PROJ-1-thing" },
  ]);

  const dirty = parseStatus(
    [
      "# branch.head PROJ-1-thing",
      "# branch.upstream origin/PROJ-1-thing",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "? build/out.js",
    ].join("\n"),
  );
  expect(dirty).toEqual({
    staged: false, // the first letter is the staged state, the second the unstaged one
    modified: true,
    untracked: true,
    upstream: "origin/PROJ-1-thing",
    ahead: 2,
    behind: 1,
  });

  // A branch that was never pushed has no upstream and no counts.
  const fresh = parseStatus("# branch.head PROJ-1-thing\n");
  expect(fresh).toEqual({
    staged: false,
    modified: false,
    untracked: false,
    upstream: undefined,
    ahead: 0,
    behind: 0,
  });
});

test("an asynchronous merge is followed until it is no longer pending", () => {
  // Keep waiting only while it is running; both of the other endings are endings.
  expect(outcomeOf({ status: "pending", details: { uuid: "u" } })).toEqual({ waiting: true });
  expect(outcomeOf({ status: "merged", details: { sha: "abc" } })).toEqual({ waiting: false });
  // A stack that went into the merge queue has left our hands, and did not fail.
  expect(outcomeOf({ status: "enqueued" })).toEqual({
    waiting: false,
    note: "added to the merge queue",
  });
  // Whatever GitHub says is why, said back: "the merge failed" helps nobody.
  expect(outcomeOf({ status: "failed", details: { message: "Merge conflict." } })).toEqual({
    waiting: false,
    error: "Merge conflict.",
  });
  expect(outcomeOf({ status: "failed" }).error).toBe("the merge failed");
});

test("a pull request is looked up by the branch that was pushed", () => {
  // The ordinary case: the branch is its own upstream.
  expect(headRef("PROJ-1", "origin/PROJ-1", "origin/main")).toBe("PROJ-1");
  expect(headRef("PROJ-1", undefined, "origin/main")).toBe("PROJ-1"); // never pushed

  // Renamed, or made around work that already existed: the pull request belongs to the branch
  // that was pushed, not to the one you have locally.
  expect(headRef("PROJ-1671-2", "origin/PROJ-1671-improve-mileage", "origin/master")).toBe(
    "PROJ-1671-improve-mileage",
  );

  // Tracking the default branch is the old in-place bug, not a pull request to go looking for.
  expect(headRef("PROJ-1", "origin/main", "origin/main")).toBe("PROJ-1");
})

test("a merge poll that fails is not mistaken for one still running", () => {
  expect(pollResult(0, '{"status":"merged","details":{"sha":"abc"}}')).toEqual({
    status: "merged",
    details: { sha: "abc" },
  });
  // 404 when the merge request expired, or any other failure: unreadable, not pending.
  expect(pollResult(1, '{"message":"Not Found","status":"404"}')).toBeUndefined();
  expect(pollResult(0, "")).toBeUndefined();
  expect(pollResult(0, "not json at all")).toBeUndefined();
});

test("a review thread you answered last is not waiting on you", () => {
  const thread = (isResolved: boolean, ...logins: string[]) => ({
    isResolved,
    comments: { nodes: logins.map((login) => ({ author: { login } })) },
  });
  const threads = [
    thread(false, "reviewer"), // asked, unanswered: yours
    thread(false, "reviewer", "octocat"), // you replied: theirs to resolve
    thread(false, "octocat", "reviewer"), // they came back: yours again
    thread(true, "reviewer"), // resolved, whoever spoke last
  ];
  expect(waitingOnYou(threads, "octocat")).toBe(2);

  // Only the reviewer resolves a thread, so without this every answered thread would sit in the
  // count until they got round to looking.
  expect(threads.filter((t) => !t.isResolved).length).toBe(3);

  // No viewer to compare against, or an author we cannot read: counted, since "yes" is safe.
  expect(waitingOnYou(threads, undefined)).toBe(3);
  expect(waitingOnYou([{ isResolved: false, comments: { nodes: [] } }], "octocat")).toBe(1);
});

test("a repository's line says what is uncommitted and what is only here", async () => {
  const { summarise } = await import("../src/web/LocalPane.tsx");
  const status = (files: unknown[], unpushed = 0) => ({
    repo: "/r",
    name: "r",
    files: files as never[],
    unpushed,
    tracked: true,
  });

  // "Nothing here" is an answer, and gets a heading of its own rather than being left out.
  expect(summarise(status([]))).toEqual({ text: "clean", state: "ok" });
  expect(summarise(status([1]))).toEqual({ text: "1 change", state: "pending" });
  expect(summarise(status([1, 2]))).toEqual({ text: "2 changes", state: "pending" });

  // A clean repository with commits nobody else has looks finished and is not.
  expect(summarise(status([], 3))).toEqual({ text: "3 unpushed", state: "pending" });
  expect(summarise(status([1], 2))).toEqual({ text: "1 change, 2 unpushed", state: "pending" });

  expect(summarise({ ...status([]), error: "no worktree" })).toEqual({
    text: "no worktree",
    state: "error",
  });
  // Not asked yet is not the same as clean.
  expect(summarise(undefined)).toEqual({ text: "…", state: "none" });
});

test("what an environment holds is the newest run that was sent to it", async () => {
  const { latestFor, versionIn, serviceName } = await import("../src/deployments.ts");
  const run = (
    id: number,
    environment: string,
    version: string,
    result: string | null,
    status = "completed",
  ) => ({
    id,
    buildNumber: `${environment} - ${version}`,
    status,
    result,
    sourceBranch: "refs/heads/main",
    finishTime: "2026-09-01T10:00:00Z",
    startTime: "2026-09-01T09:55:00Z",
    templateParameters: { environment, dockerTag: version },
  });

  const runs = [
    run(3, "production", "v3", "succeeded"),
    run(2, "accept", "v3", "succeeded"),
    run(1, "accept", "v2", "succeeded"),
  ];
  expect(latestFor(runs, "accept")).toMatchObject({ version: "v3", state: "ok" });
  expect(latestFor(runs, "production")).toMatchObject({ version: "v3", state: "ok" });
  // An environment nobody has deployed to says so rather than pretending to be empty.
  expect(latestFor(runs, "sandbox")).toMatchObject({ state: "none", detail: "never deployed" });

  // A deploy in flight is what that environment is doing, whatever it holds at this moment.
  expect(latestFor([run(4, "accept", "v4", null, "inProgress"), ...runs], "accept")).toMatchObject({
    state: "pending",
    detail: "deploying v4",
  });

  // A failed deploy leaves the previous version running: the state is red, and the version is
  // the one that is actually there.
  expect(latestFor([run(4, "accept", "v4", "failed"), ...runs], "accept")).toMatchObject({
    state: "error",
    version: "v3",
  });

  // The version parameter is not called the same thing in every pipeline: one of these deploys
  // an image, the other a docker tag, and both are "the thing being deployed".
  expect(versionIn({ environment: "accept", dockerTag: "v1" })).toBe("v1");
  expect(versionIn({ environment: "accept", imageTag: "v2" })).toBe("v2");
  // Nothing to go on: two unknown parameters could be anything, so it says nothing.
  expect(versionIn({ environment: "accept", a: "1", b: "2" })).toBeUndefined();
  expect(versionIn(null)).toBeUndefined();

  // The service is what the pipelines are named after.
  expect(serviceName("deploy-example-service")).toBe("example-service");
  expect(serviceName("something-else")).toBe("something-else");
});

test("a later environment only gets what the one before it already has", async () => {
  const { deploy, branchOf } = await import("../src/deployments.ts");

  // The gate, which is the manual step of the shell script it replaces: production gets what
  // acceptance proved, not what somebody hoped. The refusal names what is actually on accept.
  expect(deploy("no-such-service", "v9", "production")).rejects.toThrow(
    /no deploy pipeline|not on accept|no Azure/,
  );
  expect(deploy("anything", "v1", "staging")).rejects.toThrow(/unknown environment: staging/);

  // What a build was built from, said the way you would say it.
  expect(branchOf("refs/heads/main")).toBe("main");
  expect(branchOf("refs/pull/169/merge")).toBe("PR #169");
  expect(branchOf(undefined)).toBe("");
});
