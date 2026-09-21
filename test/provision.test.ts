import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  describe,
  findWorktree,
  unsafeIn,
  openers,
  parseWorktrees,
  parseStatus,
  type WorktreeEntry,
} from "../apps/server/src/vendors/git.ts";
import { isMac } from "../apps/server/src/capabilities/os.ts";
import { versionInLines } from "../apps/server/src/extensions/azure-devops/pipelines.ts";
import { deploySettingsOf } from "../apps/server/src/extensions/azure-devops/deploySettings.ts";
import { readiness, headRef, waitingOnYou } from "../apps/server/src/vendors/github.ts";
import { presentWindow, type PresentedWindow } from "../apps/server/src/terminals/server/index.ts";
import type { TmuxWindow } from "../apps/server/src/integrations/types.ts";
import type { Change } from "../apps/server/src/domain/change.ts";
import { runDeploy, runEffect, runSetRepos } from "./helpers.ts";

/**
 * A changes root of its own, because some of what is tested here writes one. A change may be
 * emptied, and without this the test writes into whatever changes root the machine is configured
 * with — on the author's machine, the real one.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-provision-"));
  process.env.CORVI_ROOT = tmp;
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "archive");
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

test("a worktree entry describes what it holds", () => {
  const entries = JSON.parse(
    `[{"branch":"main","path":"/r","is_main":true,"working_tree":{},"remote":{"branch":"main","ahead":0,"behind":0}},
      {"branch":"PROJ-1-thing","path":"/r/.worktrees/PROJ-1-thing","working_tree":{"modified":true},
       "remote":{"branch":"PROJ-1-thing","ahead":2,"behind":1},"main_state":"diverged"}]`,
  ) as WorktreeEntry[];

  const entry = findWorktree(entries, "PROJ-1-thing");
  expect(entry?.path).toBe("/r/.worktrees/PROJ-1-thing");
  expect(describe(entry!)).toEqual({
    detail: "uncommitted changes, 2 unpushed, 1 behind",
    state: "pending",
  });
  expect(describe(entries[0]!)).toEqual({ detail: "clean", state: "ok" });
  expect(findWorktree(entries, "absent")).toBeUndefined();
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
  // No decision at all: the repository requires no review, so nothing is pending.
  expect(readiness({ reviewDecision: null })).toEqual({ text: "no review required" });
  expect(readiness({})).toEqual({ text: "no review required" });
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

test("what a worktree removal would destroy", () => {
  const entry = (over: Partial<WorktreeEntry>): WorktreeEntry => ({
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
  expect(unsafeIn(entry({ remote: { branch: "b", ahead: 2 }, main_state: "diverged" }))?.kind).toBe(
    "unpushed",
  );
  // Ahead of the upstream but main_state is unknown (no origin remote, a failed lookup): unknown
  // is not "in main", so the commits still warn. Failing open here would drop a removal warning.
  expect(
    unsafeIn(entry({ remote: { branch: "b", ahead: 2 }, main_state: undefined }))?.kind,
  ).toBe("unpushed");
  // Never pushed at all: no upstream to be ahead of, but the commits vanish with the branch.
  expect(unsafeIn(entry({ remote: null, main_state: "ahead" }))?.kind).toBe("unpushed");
  // Never pushed, and no default branch to measure against — a repository with no remote at all.
  // Unknown is not "in main": the commits exist only on that branch, so they still warn.
  expect(unsafeIn(entry({ remote: null, main_state: undefined }))?.kind).toBe("unpushed");
  // Never pushed, but main already has the work: nothing to lose.
  expect(unsafeIn(entry({ remote: null, main_state: "integrated" }))).toBeUndefined();
  // Ahead of the upstream, but main already has the content: removing drops a copy.
  expect(
    unsafeIn(entry({ remote: { branch: "b", ahead: 2 }, main_state: "integrated" })),
  ).toBeUndefined();
});

test("blank entries are not repositories, and a repository is not listed twice", async () => {
  // The list arrives from a browser: whitespace is nothing, and adding the same path twice is a
  // double click rather than two repositories.
  const emptied = await runSetRepos({ ...change, repos: [] }, ["  ", ""]);
  expect((emptied as { change: Change }).change.repos).toEqual([]);

  // Listed twice, and already there: nothing is created, so this needs no repository on disk.
  const once = await runSetRepos({ ...change, repos: ["/r/a"] }, ["/r/a", "/r/a"]);
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

test("a terminal window is labelled by where it is, or what you named it", () => {
  // The server-side composition, exactly as a window crosses to the page: raw tmux facts in,
  // the presented shape out.
  const w = (over: Partial<TmuxWindow>): PresentedWindow =>
    presentWindow({
      index: 0,
      id: "@1",
      name: "zsh",
      command: "zsh",
      active: true,
      activity: false,
      directory: "example-api",
      named: false,
      options: {},
      ...over,
    });
  // tmux's default name is the command, which says less than the directory does.
  expect(w({}).label).toBe("example-api");
  // Any plain shell, not only zsh: a prompt is a place, not a program — bash and sh included,
  // which is what a machine whose shell is not zsh used to get wrong.
  expect(w({ command: "bash" }).label).toBe("example-api");
  expect(w({ command: "sh" }).label).toBe("example-api");
  expect(w({}).attention).toBe(false);
  expect(w({}).id).toBe("@1");
  expect(w({ command: "vim" }).label).toBe("example-api - (vim)");
  // A window you named yourself keeps its name, wherever it wandered off to.
  expect(w({ name: "deploy", command: "gradle", named: true }).label).toBe("deploy - (gradle)");
  // An agent is `node` to tmux, which says nothing; what it says about itself replaces that,
  // read from the `@agent_status` pane option the agents extension declares.
  const working = w({ command: "node", options: { "@agent_status": "working" } });
  expect(working.label).toBe("example-api - (pi working)");
  expect(working.icon).toBe("agent");
  expect(working.state).toBe("ok");
  expect(working.busy).toBe(true);
  // Working is not wanting: nothing to notify about until it stops.
  expect(working.attention).toBe(false);
  const waiting = w({ command: "node", options: { "@agent_status": "waiting" } });
  expect(waiting.label).toBe("example-api - (pi waiting)");
  expect(waiting.state).toBe("idle");
  expect(waiting.busy).toBe(false);
  // Waiting is what notifications are for, and the agent's own words ride along beside it.
  expect(waiting.attention).toBe(true);
  const said = w({
    command: "node",
    options: { "@agent_status": "waiting", "@agent_last_message": "I fixed the layout." },
  });
  expect(said.attention).toBe(true);
  expect(said.note).toBe("I fixed the layout.");
  // A session pi has named is called that, not "example-api - (pi working)": the state is left to
  // the icon's colour, so the label does not have to repeat it.
  const named = w({
    command: "node",
    options: { "@agent_status": "working", "@agent_session_name": "Build orders" },
  });
  expect(named.label).toBe("Build orders");
  expect(named.icon).toBe("agent");
  expect(named.state).toBe("ok");
  // Nothing is repeated: a window named after what runs in it says it once.
  expect(w({ name: "logs", command: "logs", directory: "x", named: true }).label).toBe("logs");
  // The detail is the long form, what the tooltip reads.
  expect(w({}).detail).toBe("zsh (zsh) in example-api");
})

test("opening a repository uses the platform's own launcher", () => {
  const command = (id: string): string[] => openers.find((o) => o.id === id)!.command("/w/repo");
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

test("a pull request is looked up by the branch that was pushed", () => {
  // The ordinary case: the branch is its own upstream.
  expect(headRef("PROJ-1", "origin/PROJ-1", "origin/main")).toBe("PROJ-1");
  expect(headRef("PROJ-1", undefined, "origin/main")).toBe("PROJ-1"); // never pushed

  // Renamed, or made around work that already existed: the pull request belongs to the branch
  // that was pushed, not to the one you have locally.
  expect(headRef("PROJ-1671-2", "origin/PROJ-1671-improve-mileage", "origin/master")).toBe(
    "PROJ-1671-improve-mileage",
  );

  // Tracking the default branch is not a pull request to go looking for.
  expect(headRef("PROJ-1", "origin/main", "origin/main")).toBe("PROJ-1");
})

test("a review thread you answered last is not waiting on you", () => {
  const thread = (isResolved: boolean, ...logins: string[]): { isResolved: boolean; comments: { nodes: { author: { login: string; }; }[]; }; } => ({
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

test("what an environment holds is the newest run that was sent to it", async () => {
  const { latestFor, versionIn, serviceName } = await import("../apps/server/src/extensions/azure-devops/server.ts");
  const settings = deploySettingsOf(undefined, {});
  const run = (
    id: number,
    environment: string,
    version: string,
    result: string | null,
    status = "completed",
  ): { id: number; buildNumber: string; status: string; result: string | null; sourceBranch: string; finishTime: string; startTime: string; templateParameters: { environment: string; dockerTag: string; }; } => ({
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
  expect(latestFor(runs, "accept", settings, { key: "t", args: [] })).toMatchObject({ version: "v3", state: "ok" });
  expect(latestFor(runs, "production", settings, { key: "t", args: [] })).toMatchObject({ version: "v3", state: "ok" });
  // An environment nobody has deployed to says so rather than pretending to be empty.
  expect(latestFor(runs, "sandbox", settings, { key: "t", args: [] })).toMatchObject({ state: "none", detail: "never deployed" });

  // A deploy in flight is what that environment is doing, whatever it holds at this moment.
  expect(latestFor([run(4, "accept", "v4", null, "inProgress"), ...runs], "accept", settings, { key: "t", args: [] })).toMatchObject({
    state: "pending",
    detail: "deploying v4",
  });

  // A failed deploy leaves the previous version running: the state is red, and the version is
  // the one that is actually there.
  expect(latestFor([run(4, "accept", "v4", "failed"), ...runs], "accept", settings, { key: "t", args: [] })).toMatchObject({
    state: "error",
    version: "v3",
  });

  // The version parameter is not called the same thing in every pipeline: one of these deploys
  // an image, the other a docker tag, and both are "the thing being deployed".
  expect(versionIn({ environment: "accept", dockerTag: "v1" }, settings)).toBe("v1");
  expect(versionIn({ environment: "accept", imageTag: "v2" }, settings)).toBe("v2");
  // Nothing to go on: two unknown parameters could be anything, so it says nothing.
  expect(versionIn({ environment: "accept", a: "1", b: "2" }, settings)).toBeUndefined();
  expect(versionIn(null, settings)).toBeUndefined();

  // The service is what the pipelines are named after.
  expect(serviceName("deploy-example-service", settings)).toBe("example-service");
  expect(serviceName("something-else", settings)).toBe("something-else");
});

test("a later environment only gets what the one before it already has", async () => {
  const { branchOf } = await import("../apps/server/src/extensions/azure-devops/server.ts");

  // The gate, which is the manual step of the shell script it replaces: production gets what
  // acceptance proved, not what somebody hoped. The refusal names what is actually on accept.
  expect(runDeploy("no-such-service", "v9", "production")).rejects.toThrow(
    /no deploy pipeline|not on accept|no Azure/,
  );
  expect(runDeploy("anything", "v1", "staging")).rejects.toThrow(/unknown environment: staging/);

  // What a build was built from, said the way you would say it.
  expect(branchOf("refs/heads/main")).toBe("main");
  expect(branchOf("refs/pull/169/merge")).toBe("PR #169");
  expect(branchOf(undefined)).toBe("");
});
