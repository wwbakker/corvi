import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Change, CompletionStep } from "../src/core/domain/change.ts";
import {
  completeChange,
  completionOf,
  progressOf,
  stepsFor,
  verdict,
} from "../src/change/server/index.ts";
import { changeDir, createChange, readChange, writeSidecar } from "../src/change/server/index.ts";
import { config } from "../src/workspace/server/index.ts";
import { Effect } from "effect";
import { fakeShell, runEffect, runWithShell, TestError, type FakeShell, type ShellCall } from "./helpers.ts";
import { install, loaded } from "../src/core/host/registry.ts";

/**
 * Completing a change is a sequence of irreversible steps across repositories, extensions and
 * one change directory. The verdict decides whether to start at all, the plan says what is
 * coming before anything runs, and the journal says where a stopped completion stopped.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-complete-"));
  process.env.IWE_ROOT = join(tmp, "changes");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const changeWith = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-x",
  branch: "PROJ-x",
  repos: [],
  state: "In Progress",
  createdAt: new Date().toISOString(),
  ...over,
});

test("verdict: every repository must be ready, and unsafe work blocks the whole change", () => {
  const merged = { ready: true, merged: true } as const;
  const approved = (n: number) => ({ ready: true, merged: false, number: n }) as const;
  const blocked = (reason: string) => ({ ready: false, reason }) as const;

  // An empty change is ready and has nothing to merge.
  expect(verdict([])).toEqual({ ready: true, reasons: [], toMerge: [] });

  // Ready pull requests are queued in order, including the ones already merged by hand.
  expect(
    verdict([
      { repo: "/r/a", readiness: merged },
      { repo: "/r/b", readiness: approved(2) },
      { repo: "/r/c", readiness: approved(3) },
    ]),
  ).toEqual({
    ready: true,
    reasons: [],
    toMerge: [
      { repo: "/r/b", number: 2 },
      { repo: "/r/c", number: 3 },
    ],
  });

  // A blocked repository names itself; unsafe work is said beside the readiness reason, and a
  // bare repository name has no directory part to strip.
  expect(
    verdict([
      { repo: "a", readiness: blocked("a: not approved"), unsafe: { text: "uncommitted changes" } },
      { repo: "/parent/b", readiness: approved(3), unsafe: { text: "2 unpushed commit(s)" } },
    ]),
  ).toEqual({
    ready: false,
    reasons: ["a: not approved", "a: uncommitted changes", "b: 2 unpushed commit(s)"],
    toMerge: [{ repo: "/parent/b", number: 3 }],
  });
});

test("stepsFor: merges first, then the contributed steps, then the core teardown", () => {
  const step = (id: string): CompletionStep => ({ id, label: id, state: "waiting" });
  const plan = stepsFor(
    changeWith({ repos: ["/parent/myrepo"] }),
    { ready: true, reasons: [], toMerge: [{ repo: "/parent/myrepo", number: 7 }] },
    [step("jira"), step("close-issue")],
  );

  expect(plan.map((s) => s.id)).toEqual([
    "merge:/parent/myrepo",
    "jira",
    "close-issue",
    "worktrees",
    "terminal",
    "archive",
  ]);
  // The label names the repository, not its whole path.
  expect(plan[0]!.label).toBe("merge myrepo #7");
  expect(plan.every((s) => s.state === "waiting")).toBe(true);
});

test("stepsFor: a change with nothing to merge still plans the teardown", () => {
  const plan = stepsFor(changeWith(), { ready: true, reasons: [], toMerge: [] }, []);
  expect(plan.map((s) => s.id)).toEqual(["worktrees", "terminal", "archive"]);
});

test("stepsFor: the change's own extensions plan their steps when none are passed", () => {
  // The default argument reads the live workspace config, so pin a workspace that enables every
  // extension: the plan is what the change's own extensions say, not this machine's settings.
  const saved = config.workspaces;
  config.workspaces = [{ id: "test-all", name: "test" }];
  try {
    const plan = stepsFor(
      changeWith({ jira: "PROJ-9" }),
      { ready: true, reasons: [], toMerge: [] },
    );
    expect(plan.map((s) => s.id)).toEqual(["jira", "worktrees", "terminal", "archive"]);
    expect(plan[0]!.label).toContain("PROJ-9");
  } finally {
    config.workspaces = saved;
  }
});

test("progressOf: no record is none, and a half-written record reads as none", async () => {
  const change = await runEffect(
    createChange({ id: "PROJ-PROGRESS", branch: "PROJ-PROGRESS", repos: [join(tmp, "r")] }),
  );
  expect(await runEffect(progressOf(change.id))).toBeNull();

  // A truncated or corrupted journal is not a failure of the page: the completion that was
  // interrupted rewrites it from where it got to.
  await runEffect(writeSidecar(change.id, "completion.json", "{ not json"));
  expect(await runEffect(progressOf(change.id))).toBeNull();

  const record = {
    startedAt: "2026-01-01T00:00:00.000Z",
    steps: [{ id: "check", label: "check", state: "done" as const }],
  };
  await runEffect(writeSidecar(change.id, "completion.json", JSON.stringify(record)));
  expect(await runEffect(progressOf(change.id))).toEqual(record);
});

type PullRequestJson = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  mergeable: string;
  statusCheckRollup: unknown[];
};

const approved = (number = 7): PullRequestJson => ({
  number,
  title: "do the thing",
  url: `https://github.com/org/repo/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  statusCheckRollup: [],
});

/** A worktree as `git worktree list --porcelain` reports it, for the change's branch. */
const worktreeAt = (path: string, branch: string): string =>
  `worktree ${path}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/${branch}\n`;

type CompletionShellOptions = {
  /** The worktree path, or nothing when the change has none in this repository. */
  worktree?: string;
  /** The branch the worktree holds; only meaningful when `worktree` is set. */
  branch?: string;
  /** The pull request `gh pr list` answers, or null for none. */
  pr?: Record<string, unknown> | null;
  /** The working tree status that decides whether a removal would lose work. */
  status?: string;
  /** How `gh pr merge` answers. */
  merge?: { code: number; stderr?: string };
};

/** A scripted shell for the completion lookups: git for the worktree and its status, gh for the
 * pull request and the merge. */
const completionShell = (opts: CompletionShellOptions): FakeShell =>
  fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "git worktree list --porcelain") {
      return opts.worktree ? worktreeAt(opts.worktree, opts.branch ?? "") : "";
    }
    if (line === "git status --porcelain=v2 --branch") return opts.status ?? "";
    if (line === "git remote") return "";
    if (line.startsWith("git rev-parse --abbrev-ref --symbolic-full-name")) return "";
    if (line.startsWith("gh pr list")) return JSON.stringify(opts.pr ? [opts.pr] : []);
    if (line.startsWith("gh repo view")) return "";
    if (line.startsWith("gh pr merge")) return opts.merge ?? { code: 0 };
    if (line.startsWith("wt --config")) return "";
    if (line.startsWith("tmux kill-session")) return "";
    return undefined;
  });

test("completionOf: a live look at one repository becomes the change's verdict", async () => {
  const repo = join(tmp, "ready-repo");
  const change = changeWith({ repos: [repo], branch: "PROJ-ready" });
  const shell = completionShell({
    worktree: join(tmp, "wt-ready"),
    branch: change.branch,
    pr: approved(7),
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    toMerge: [{ repo, number: 7 }],
  });
});

test("completionOf: a pull request merged by hand leaves nothing to merge", async () => {
  const repo = join(tmp, "merged-repo");
  const change = changeWith({ repos: [repo], branch: "PROJ-merged" });
  const shell = completionShell({
    worktree: join(tmp, "wt-merged"),
    branch: change.branch,
    pr: { ...approved(7), state: "MERGED" },
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    toMerge: [],
  });
});

test("completionOf: no worktree and no pull request each block, and say which", async () => {
  const noWorktree = join(tmp, "nowt-repo");
  const first = changeWith({ repos: [noWorktree], branch: "PROJ-nowt" });
  expect(await runWithShell(completionShell({}), completionOf(first))).toEqual({
    ready: false,
    reasons: [`${basename(noWorktree)}: no worktree`],
    toMerge: [],
  });

  const noPr = join(tmp, "nopr-repo");
  const second = changeWith({ repos: [noPr], branch: "PROJ-nopr" });
  expect(
    await runWithShell(
      completionShell({ worktree: join(tmp, "wt-nopr"), branch: second.branch, pr: null }),
      completionOf(second),
    ),
  ).toEqual({
    ready: false,
    reasons: [`${basename(noPr)}: no pull request`],
    toMerge: [],
  });
});

test("completionOf: work the remote never saw blocks an otherwise approved change", async () => {
  const repo = join(tmp, "dirty-repo");
  const change = changeWith({ repos: [repo], branch: "PROJ-dirty" });
  const shell = completionShell({
    worktree: join(tmp, "wt-dirty"),
    branch: change.branch,
    pr: approved(7),
    status: "? half-done.txt\n",
  });
  const result = await runWithShell(shell, completionOf(change));
  expect(result.ready).toBe(false);
  expect(result.reasons).toEqual([`${basename(repo)}: uncommitted changes`]);
  // The merge is still queued: it is the unsafe work, not readiness, that stops it.
  expect(result.toMerge).toEqual([{ repo, number: 7 }]);
});

test("completeChange: a step that fails stops where it stands and journals it", async () => {
  const repo = join(tmp, "fail-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-FAIL", branch: "PROJ-FAIL", repos: [repo] }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-fail"),
    branch: change.branch,
    pr: approved(7),
    merge: { code: 1, stderr: "Pull request is not mergeable" },
  });
  await expect(runWithShell(shell, completeChange(change))).rejects.toThrow(/not mergeable/);

  const stopped = (await runEffect(progressOf(change.id)))!;
  const byId = (id: string): CompletionStep => stopped.steps.find((s) => s.id === id)!;
  expect(byId("check").state).toBe("done");
  expect(byId(`merge:${repo}`).state).toBe("failed");
  expect(byId(`merge:${repo}`).detail).toContain("not mergeable");
  // Nothing after the failure ran: the later steps are still waiting.
  expect(byId("worktrees").state).toBe("waiting");
  expect(byId("terminal").state).toBe("waiting");
  expect(byId("archive").state).toBe("waiting");
  expect(stopped.error).toContain("not mergeable");
  expect(stopped.finishedAt).toBeTruthy();
  // Still where it was, not archived: a failed completion changed nothing on disk.
  expect((await runEffect(readChange(change.id)))?.state).toBe("In Progress");
});

test("completeChange: every step is journaled as it runs and the change is archived", async () => {
  const repo = join(tmp, "ok-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-OK", branch: "PROJ-OK", repos: [repo] }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-ok"),
    branch: change.branch,
    pr: approved(7),
  });
  const result = await runWithShell(shell, completeChange(change));

  expect(result.notes).toEqual([]);
  expect(result.change.state).toBe("Completed");
  expect(result.change.completedAt).toBeTruthy();

  // The journal, in order, says every step ran.
  const journal = (await runEffect(progressOf(change.id)))!;
  expect(journal.steps.map((s) => [s.id, s.state])).toEqual([
    ["check", "done"],
    [`merge:${repo}`, "done"],
    ["worktrees", "done"],
    ["terminal", "done"],
    ["archive", "done"],
  ]);
  expect(journal.finishedAt).toBeTruthy();

  // The record moved into the archive, journal and all.
  expect(await Bun.file(join(changeDir(change.id), "change.json")).exists()).toBe(false);
  expect((await runEffect(readChange(change.id)))?.state).toBe("Completed");
  // Every command went through the scripted seam — no real CLI, server or tmux.
  const asked = (shell.calls as ShellCall[]).map((c) => c.cmd.join(" "));
  expect(asked).toContain(`gh pr merge 7 --squash`);
  expect(asked.some((line) => line.startsWith("wt --config"))).toBe(true);
  expect(asked).toContain(`tmux kill-session -t iwe-${change.id}`);
});

test("completeChange: a failing change:completing hook vetoes before any merge", async () => {
  const repo = join(tmp, "veto-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-VETO", branch: "PROJ-VETO", repos: [repo] }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-veto"),
    branch: change.branch,
    pr: approved(7),
  });
  const saved = loaded.splice(0, loaded.length);
  install({
    name: "veto-complete",
    title: "Veto",
    events: { "change:completing": [() => Effect.fail(new TestError({ message: "hold" }))] },
  });
  try {
    await expect(runWithShell(shell, completeChange(change))).rejects.toThrow("hold");
  } finally {
    loaded.splice(0, loaded.length, ...saved);
  }
  // The merge never ran: the veto came before the irreversible step, and the change is untouched.
  expect(shell.calls.some((c) => c.cmd.join(" ").startsWith("gh pr merge"))).toBe(false);
  expect((await runEffect(readChange(change.id)))?.state).toBe("In Progress");
  // The veto is legible afterwards rather than leaving a completion looking half-started.
  const journal = (await runEffect(progressOf(change.id)))!;
  expect(journal.steps[0]).toMatchObject({ id: "check", state: "failed", detail: "hold" });
  expect(journal.finishedAt).toBeTruthy();
});
