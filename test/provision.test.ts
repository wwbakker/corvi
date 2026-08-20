import { test, expect } from "bun:test";
import { provision, integrations } from "../src/integrations/index.ts";
import { describe, findWorktree, setRepos, unsafeIn, type WtEntry } from "../src/integrations/git.ts";
import {
  averageDuration,
  folderFor,
  refsFor,
  runState,
  versionInLines,
} from "../src/integrations/azure.ts";
import { readiness, repoFromUrl, groupChecks, stackRequest, describeStack } from "../src/integrations/github.ts";
import { verdict } from "../src/complete.ts";
import { describeChange } from "../src/description.ts";
import { windowLabel } from "../src/web/WindowStrip.tsx";
import type { Change, Integration } from "../src/types.ts";

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
  expect(folderFor("/Users/me/Repos/acme/example-legacy/example-worker")).toBe(
    "\\example-worker",
  );
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
  expect(repoFromUrl("https://github.com/acme/example-service/pull/720")).toEqual({
    owner: "acme",
    name: "example-service",
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

test("a change cannot edit itself down to no repositories", () => {
  expect(setRepos({ ...change, repos: ["/r/a"] }, [])).rejects.toThrow("at least one repository");
  expect(setRepos({ ...change, repos: ["/r/a"] }, ["  "])).rejects.toThrow(
    "at least one repository",
  );
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
    check("acme.frontend-app", "pass"),
    check("acme.frontend-app (CI App @acme/example-app)", "fail"),
    check("acme.frontend-app (CI Affected Build)", "pending"),
    check("sonarqube", "pass"),
  ]);
  expect(items.map((i) => i.label)).toEqual(["acme.frontend-app", "sonarqube"]);

  const [turbo, sonar] = items;
  // A failure anywhere in the group colours the group, and the counts say what is going on.
  expect(turbo!.state).toBe("error");
  expect(turbo!.detail).toBe("3 checks · 1 failing · 1 running");
  // The check named exactly like the group is the build itself, not one of its jobs.
  expect(turbo!.children!.map((c) => c.label)).toEqual([
    "overall",
    "CI App @acme/example-app",
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
      directory: "example-worker",
      named: false,
      ...over,
    });
  // tmux's default name is the command, which says less than the directory does.
  expect(w({})).toBe("example-worker");
  expect(w({ command: "vim" })).toBe("example-worker - (vim)");
  // A window you named yourself keeps its name, wherever it wandered off to.
  expect(w({ name: "deploy", command: "gradle", named: true })).toBe("deploy - (gradle)");
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
