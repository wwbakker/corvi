import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Change, CompletionStep } from "@corvi/changes/record";
import {
  completeChange,
  completionOf,
  progressOf,
  verdict,
} from "../apps/server/src/change/server/index.ts";
import { plannedCompletionSteps, providerError } from "../apps/server/src/change/lifecycle-layer.ts";
import { changeDir, createChange, readChange, writeSidecar } from "../apps/server/src/change/server/index.ts";
import { runtimeConfig } from "../apps/server/src/workspace/server/index.ts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { checkoutsOf, fakeShell, forgetRateLimit, runEffect, runRouteWithShell, runWithShell, runWithShellWithTestClock, TestError, type FakeShell, type ShellCall  } from "./helpers.ts";
import { prItem, REPOSITORY_CONCURRENCY } from "@corvi/github/client";
import { checkItems } from "@corvi/github/checks";
import { githubSummaryContributor } from "@corvi/github";
import { contentInMain, integrated } from "../apps/server/src/vendors/git.ts";
import { changeActions } from "../apps/web/src/change-page/client/changeActions.ts";

/**
 * Completing a change is a sequence of irreversible steps across repositories, extensions and
 * one change directory. The verdict decides whether to start at all, the plan says what is
 * coming before anything runs, and the journal says where a stopped completion stopped.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-complete-"));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const changeWith = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-x",
  branch: "PROJ-x",
  checkouts: checkoutsOf([]),
  state: "Implementation",
  createdAt: new Date().toISOString(),
  ...over,
});

test("verdict: every repository must be ready, and unsafe work blocks the whole change", () => {
  const merged = { ready: true, merged: true } as const;
  const approved = (n: number) => ({ ready: true, merged: false, number: n }) as const;
  const blocked = (reason: string, kind: "forceable" | "hard" = "forceable") =>
    ({ ready: false, reason, kind }) as const;

  // An empty change is ready and has nothing to merge.
  expect(verdict([])).toEqual({ ready: true, reasons: [], tagged: [], toMerge: [] });

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
    tagged: [],
    toMerge: [
      { repo: "/r/b", number: 2 },
      { repo: "/r/c", number: 3 },
    ],
  });

  // A blocked repository names itself; unsafe work is said beside the readiness reason, and a
  // bare repository name has no directory part to strip. Readiness and unpushed commits are
  // forceable; uncommitted work is hard — it exists nowhere else.
  expect(
    verdict([
      {
        repo: "a",
        readiness: blocked("a: not approved"),
        unsafe: { kind: "dirty", text: "uncommitted changes" },
      },
      {
        repo: "/parent/b",
        readiness: approved(3),
        unsafe: { kind: "unpushed", text: "2 unpushed commit(s)" },
      },
    ]),
  ).toEqual({
    ready: false,
    reasons: ["a: not approved", "a: uncommitted changes", "b: 2 unpushed commit(s)"],
    tagged: [
      { text: "a: not approved", kind: "forceable" },
      { text: "a: uncommitted changes", kind: "hard" },
      { text: "b: 2 unpushed commit(s)", kind: "forceable" },
    ],
    toMerge: [{ repo: "/parent/b", number: 3 }],
  });
});

test("verdict: one token at its limit is one line, not ten", () => {
  const reason = (minutes: number): string =>
    `GitHub rate limit reached; resets at 12:32 UTC (in ${minutes} minutes)`;
  const completion = verdict(
    Array.from({ length: 10 }, (_, index) => ({
      repo: `/r/repo-${index}`,
      // The sentence counts down, and the repositories are asked one after another: the same fact
      // refused either side of a minute boundary is still one fact.
      readiness: { ready: false as const, reason: reason(8 - (index % 2)), kind: "hard" as const },
    })),
  );

  expect(completion.ready).toBe(false);
  // No acknowledgement clears it, and ten repositories share one token: said once.
  expect(completion.reasons).toEqual([reason(8)]);
  expect(completion.tagged).toEqual([{ text: reason(8), kind: "hard" }]);
  expect(completion.toMerge).toEqual([]);
});

test("verdict: a repository's own hard fact is that repository's, dirty worktrees and all", () => {
  const dirty = { kind: "dirty", text: "uncommitted changes" } as const;
  const limited = "GitHub rate limit reached; resets at 12:32 UTC (in 8 minutes)";

  // Two dirty worktrees are two problems to fix, both named.
  expect(
    verdict([
      { repo: "/r/one", readiness: { ready: true, merged: false, number: 1 }, unsafe: dirty },
      { repo: "/r/two", readiness: { ready: true, merged: false, number: 2 }, unsafe: dirty },
    ]),
  ).toMatchObject({
    ready: false,
    reasons: ["one: uncommitted changes", "two: uncommitted changes"],
    tagged: [
      { text: "one: uncommitted changes", kind: "hard" },
      { text: "two: uncommitted changes", kind: "hard" },
    ],
  });

  // A dirty worktree and a limited token are different facts, and both are said.
  expect(
    verdict([
      { repo: "/r/one", readiness: { ready: true, merged: false, number: 1 }, unsafe: dirty },
      {
        repo: "/r/two",
        readiness: { ready: false, reason: limited, kind: "hard" as const },
        unsafe: dirty,
      },
      { repo: "/r/three", readiness: { ready: false, reason: limited, kind: "hard" as const } },
    ]),
  ).toMatchObject({
    reasons: ["one: uncommitted changes", limited, "two: uncommitted changes"],
  });
});

test("plannedCompletionSteps: the included steps are each planned once", () => {
  // The included integrations are planned explicitly, jira before github-issues; a step must
  // not appear twice.
  const saved = runtimeConfig().workspaces;
  runtimeConfig().workspaces = [{ id: "test-all", name: "test" }];
  try {
    const plan = plannedCompletionSteps(
      changeWith({
        extensions: {
          jira: { key: "PROJ-9" },
          "github-issues": { repo: "acme/myrepo", number: 42 },
        },
      }),
    );
    expect(plan.map((s) => s.id)).toEqual(["jira", "github-issues"]);
    expect(plan[0]!.label).toBe("move PROJ-9 to Done");
    expect(plan[1]!.label).toBe("close myrepo#42");
    expect(plan.every((s) => s.state === "waiting")).toBe(true);
    // Nothing for either integration to do: no contributed step at all.
    expect(plannedCompletionSteps(changeWith())).toEqual([]);
  } finally {
    runtimeConfig().workspaces = saved;
  }
});

test("progressOf: no record is none, and a half-written record reads as none", async () => {
  const change = await runEffect(
    createChange({ id: "PROJ-PROGRESS", branch: "PROJ-PROGRESS", checkouts: checkoutsOf([join(tmp, "r")]) }),
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
  /** The remote's default branch, for the integrated-content check. */
  remoteDefault?: string;
  /** Commits main does not have, for the integrated-content check; absent means the
   * lookup fails, so the check reads "not proven". */
  beyond?: number;
  /** `git cherry` output lines, for the squash-merge content check. */
  cherry?: string[];
  /** How `gh pr merge` answers. */
  merge?: { code: number; stderr?: string };
  /** How `gh pr list` answers when it fails; absent means it lists `pr`. */
  prList?: { code: number; stderr?: string };
};

/** A scripted shell for the completion lookups: git for the worktree and its status, gh for the
 * pull request and the merge. */
const completionShell = (opts: CompletionShellOptions): FakeShell =>
  fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "git status --porcelain") {
      // The new capability reads plain porcelain; the legacy options describe a v2 record.
      return opts.status && !opts.status.startsWith("#") ? " M changed\n" : "";
    }
    if (line === "git symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/main";
    if (line === "git worktree list --porcelain") {
      return opts.worktree ? worktreeAt(opts.worktree, opts.branch ?? "") : "";
    }
    if (line === "git status --porcelain=v2 --branch") {
      // A worktree being completed has been pushed, so it has an upstream by default — that is
      // what keeps a branch whose default branch cannot be read out of the "unpushed commits"
      // question. A test that cares about dirt, being behind or having no upstream overrides it.
      return opts.status ??
        `# branch.upstream origin/${opts.branch ?? "main"}\n# branch.ab +0 -0\n`;
    }
    if (line === "git remote") return "origin";
    if (line === "git symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
      return opts.remoteDefault ?? "origin/main";
    }
    if (line.startsWith("git rev-parse --abbrev-ref --symbolic-full-name")) return "";
    if (line.startsWith("git rev-list --count")) {
      return opts.beyond === undefined ? { code: 128, stderr: "unknown revision" } : String(opts.beyond);
    }
    if (line.startsWith("git cherry ")) return (opts.cherry ?? []).join("\n");
    if (line.startsWith("gh pr list")) {
      return opts.prList ?? JSON.stringify(opts.pr ? [opts.pr] : []);
    }
    if (line.startsWith("gh repo view")) return "";
    if (line.startsWith("gh pr merge")) return opts.merge ?? { code: 0 };
    if (line.startsWith("git worktree remove --force")) return "";
    return undefined;
  });

test("completionOf: a live look at one repository becomes the change's verdict", async () => {
  const repo = join(tmp, "ready-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-ready" });
  const shell = completionShell({
    worktree: join(tmp, "wt-ready"),
    branch: change.branch,
    pr: approved(7),
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    tagged: [],
    toMerge: [{ repo, number: 7 }],
  });
});

test("completionOf: a rate-limited poll is a hard verdict, not a failure", async () => {
  const repo = join(tmp, "limited-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-limited" });
  const shell = completionShell({
    worktree: join(tmp, "wt-limited"),
    branch: change.branch,
    prList: { code: 1, stderr: "GraphQL: API rate limit already exceeded for user ID 13013300." },
  });

  const completion = await runWithShell(shell, completionOf(change));
  expect(completion.ready).toBe(false);
  expect(completion.tagged).toHaveLength(1);
  expect(completion.tagged[0]!.kind).toBe("hard");
  // The token's sentence, with no repository in front of it.
  expect(completion.tagged[0]!.text).toMatch(/^GitHub rate limit reached; resets at \d\d:\d\d UTC/);
  expect(completion.toMerge).toEqual([]);
  forgetRateLimit();
});

test("completionOf: the poll reads the display answer, the click does not", async () => {
  const repo = join(tmp, "poll-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-poll" });
  const shell = completionShell({
    worktree: join(tmp, "wt-poll"),
    branch: change.branch,
    pr: approved(7),
  });
  const asked = (): number =>
    shell.calls.map((call) => call.cmd.join(" ")).filter((line) => line.startsWith("gh pr list")).length;

  expect(await runWithShell(shell, completionOf(change))).toMatchObject({ ready: true });
  expect(await runWithShell(shell, completionOf(change))).toMatchObject({ ready: true });
  // Two polls, one display read.
  expect(asked()).toBe(1);

  // The click that decides forgets it and asks GitHub again.
  expect(await runWithShell(shell, completionOf(change, true))).toMatchObject({ ready: true });
  expect(asked()).toBe(2);
});

/** A ten-repository world in which every repository has a pushed worktree with one approved pull
 * request: nothing in the counts depends on git, only on the cache's TTLs. */
const trafficShell = (repos: readonly string[], branch: string): FakeShell => {
  const calls: ShellCall[] = [];
  // Every answer takes one turn of the scheduler, as a real `gh` takes time: the cache refreshes a
  // stale entry on a fiber of its own, and those join one in-flight refresh only while it is
  // still running — an answer that arrived instantly would make each of them spawn again.
  const out = (stdout: string): Effect.Effect<{ code: number; stdout: string; stderr: string }> =>
    Effect.andThen(Effect.yieldNow, Effect.succeed({ code: 0, stdout, stderr: "" }));
  return {
    calls,
    run: (cmd, opts) => {
      calls.push({ cmd: [...cmd], cwd: opts?.cwd });
      const line = cmd.join(" ");
      const where = opts?.cwd ?? "";
      if (line === "git worktree list --porcelain") {
        return out(`worktree ${where}\nHEAD abc\nbranch refs/heads/${branch}\n`);
      }
      if (line === "git status --porcelain") return out("");
      if (line === "git status --porcelain=v2 --branch") {
        return out(`# branch.upstream origin/${branch}\n# branch.ab +0 -0\n`);
      }
      if (line === "git remote") return out("origin");
      if (line === "git symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
        return out("origin/main");
      }
      if (line === "git symbolic-ref refs/remotes/origin/HEAD") return out("refs/remotes/origin/main");
      if (line === `git rev-parse --abbrev-ref --symbolic-full-name ${branch}@{upstream}`) {
        return out(`origin/${branch}`);
      }
      if (line.startsWith("git rev-list") || line.startsWith("git cherry") || line.startsWith("git merge-base")) {
        // Nothing to prove about main: these worktrees are clean and pushed, so a removal is
        // safe without the integration check.
        return Effect.andThen(
          Effect.yieldNow,
          Effect.succeed({ code: 128, stdout: "", stderr: "unknown revision" }),
        );
      }
      if (line.startsWith("gh pr list")) {
        const index = Math.max(0, repos.indexOf(where));
        return out(
          JSON.stringify([
            {
              number: 7,
              title: "Do the thing",
              url: `https://github.com/org/repo-${index}/pull/7`,
              state: "OPEN",
              isDraft: false,
              reviewDecision: "APPROVED",
              mergeable: "MERGEABLE",
              statusCheckRollup: [{ conclusion: "SUCCESS" }],
            },
          ]),
        );
      }
      if (line.startsWith("gh api graphql")) {
        return out(
          JSON.stringify({
            data: {
              viewer: { login: "me" },
              repository: { pullRequest: { reviewThreads: { nodes: [] } } },
            },
          }),
        );
      }
      return out("");
    },
  };
};

test("traffic: a cold first minute of polling a ten-repository change costs the calls the TTLs imply", async () => {
  const repos = Array.from({ length: 10 }, (_, index) => join(tmp, `traffic-${index}`));
  const branch = "PROJ-traffic";
  const change = changeWith({ checkouts: checkoutsOf(repos), branch });
  const shell = trafficShell(repos, branch);

  await runWithShellWithTestClock(
    shell,
    Effect.gen(function* () {
      const poll = Effect.gen(function* () {
        // One page poll: the completion tooltip, the overview's summary, and each repository's
        // card — its pull request row and its checks.
        yield* completionOf(change);
        yield* githubSummaryContributor.facts(change);
        for (const repo of repos) {
          yield* prItem(change, repo);
          yield* checkItems(change, repo, 7);
        }
        // The cache refreshes a stale entry on a daemon of its own: give those fibers their turns
        // before the clock moves, which is what a real second between polls does.
        for (let turn = 0; turn < 24; turn++) yield* Effect.yieldNow;
      });

      // The page polls every 15 s. Five polls is a minute: 0, 15, 30, 45 and 60 seconds.
      for (let tick = 0; tick < 5; tick++) {
        yield* poll;
        yield* TestClock.adjust(15_000);
      }
      for (let turn = 0; turn < 24; turn++) yield* Effect.yieldNow;

      const lines = shell.calls.map((call) => call.cmd.join(" "));
      const asked = (prefix: string): number =>
        lines.filter((line) => line.startsWith(prefix)).length;
      // A cold first minute, ten repositories in five polls:
      // - the pull request list (30 s) is asked at 0, 30 and 60 s → 3 × 10;
      // - the threads/stack query (120 s) once → 1 × 10;
      // - the checks (60 s) at 0 and 60 s → 2 × 10.
      // A change to any of those TTLs has to change these numbers deliberately.
      expect(asked("gh pr list")).toBe(30);
      expect(asked("gh api graphql")).toBe(10);
      expect(asked("gh pr checks")).toBe(20);
      expect(asked("gh ")).toBe(60);

      // Steady state, measured after the cold read and over four minutes: twice the least common
      // multiple of the three TTLs (30, 60 and 120 s), which is what makes the details average —
      // one refresh per two minutes — come out exact rather than rounded by a boundary.
      const cold = shell.calls.length;
      for (let tick = 0; tick < 16; tick++) {
        yield* poll;
        yield* TestClock.adjust(15_000);
      }
      const steady = shell.calls.slice(cold).map((call) => call.cmd.join(" "));
      const refreshed = (prefix: string): number =>
        steady.filter((line) => line.startsWith(prefix)).length;
      // Per repository per four minutes: the list 8 (every 30 s), the details 2 (every 120 s),
      // the checks 4 (every 60 s) — 14 calls, and 3.5 a minute for each repository: 2 100/h for
      // ten repositories, the plan's number.
      expect(refreshed("gh pr list")).toBe(80);
      expect(refreshed("gh api graphql")).toBe(20);
      expect(refreshed("gh pr checks")).toBe(40);
      expect(refreshed("gh ")).toBe(140);
      // A fleet without GitHub's stacks preview pays two details queries per refresh, so the same
      // four minutes cost 160 calls — 4 per repository a minute, 2 400/h for ten of them: still
      // inside the budget, and not the 2 100/h of a preview-enabled world.
    }),
  );
});

test("repository fan-outs never hold more than four gh processes at once", async () => {
  const repos = Array.from({ length: 10 }, (_, index) => join(tmp, `burst-${index}`));
  const branch = "PROJ-burst";
  const change = changeWith({ checkouts: checkoutsOf(repos), branch });
  const base = trafficShell(repos, branch);
  // What GitHub's secondary limit sees: the commands in flight at one moment, not the total.
  let inFlight = 0;
  let peak = 0;
  const shell: FakeShell = {
    calls: base.calls,
    run: (cmd, opts) => {
      const work = base.run(cmd, opts);
      if (!cmd.join(" ").startsWith("gh ")) return work;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return Effect.ensuring(work, Effect.sync(() => (inFlight -= 1)));
    },
  };

  await runWithShell(
    shell,
    Effect.gen(function* () {
      yield* completionOf(change);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(REPOSITORY_CONCURRENCY);

      // The summary's own fan-out, over repositories no earlier read has cached.
      const other = Array.from({ length: 10 }, (_, index) => join(tmp, `burst-summary-${index}`));
      peak = 0;
      yield* githubSummaryContributor.facts(
        changeWith({ checkouts: checkoutsOf(other), branch }),
      );
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(REPOSITORY_CONCURRENCY);
    }),
  );
});

test("completionOf: a pull request merged by hand leaves nothing to merge", async () => {
  const repo = join(tmp, "merged-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-merged" });
  const shell = completionShell({
    worktree: join(tmp, "wt-merged"),
    branch: change.branch,
    pr: { ...approved(7), state: "MERGED" },
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    tagged: [],
    toMerge: [],
  });
});

test("completionOf: no worktree and no pull request each block, and say which", async () => {
  const noWorktree = join(tmp, "nowt-repo");
  const first = changeWith({ checkouts: checkoutsOf([noWorktree]), branch: "PROJ-nowt" });
  expect(await runWithShell(completionShell({}), completionOf(first))).toEqual({
    ready: false,
    reasons: [`${basename(noWorktree)}: no worktree`],
    tagged: [{ text: `${basename(noWorktree)}: no worktree`, kind: "forceable" }],
    toMerge: [],
  });

  const noPr = join(tmp, "nopr-repo");
  const second = changeWith({ checkouts: checkoutsOf([noPr]), branch: "PROJ-nopr" });
  expect(
    await runWithShell(
      completionShell({ worktree: join(tmp, "wt-nopr"), branch: second.branch, pr: null }),
      completionOf(second),
    ),
  ).toEqual({
    ready: false,
    reasons: [`${basename(noPr)}: no pull request`],
    tagged: [{ text: `${basename(noPr)}: no pull request`, kind: "forceable" }],
    toMerge: [],
  });
});

test("completionOf: work the remote never saw blocks an otherwise approved change", async () => {
  const repo = join(tmp, "dirty-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-dirty" });
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
    createChange({ id: "PROJ-FAIL", branch: "PROJ-FAIL", checkouts: checkoutsOf([repo]) }),
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
  expect((await runEffect(readChange(change.id)))?.state).toBe("Implementation");
});

test("completeChange: a provider failure that said nothing says what failed, not its type", async () => {
  const repo = join(tmp, "silent-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-SILENT", branch: "PROJ-SILENT", checkouts: checkoutsOf([repo]) }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-silent"),
    branch: change.branch,
    prList: { code: 1, stderr: "" },
  });
  // `gh` failing without a word used to reach the boundary as an empty message, which the
  // transport rendered as the error's type name — the page said "ProviderError". The response
  // must name the command and how it failed instead. (Nothing is journalled: the assessment
  // fails before the completion starts, which is the same rule a refusal follows.)
  await expect(runWithShell(shell, completeChange(change))).rejects.toThrow(/gh pr list exited with code 1/);
});

test("providerError: an inner error with nothing to say gets the operation's words", () => {
  // A TaggedError without a message stringifies to its type name; the wrapper must not hand
  // an empty sentence — or that name — to the boundary.
  expect(providerError("jira", "complete", new Error("")).message).toBe("jira complete failed");
  expect(providerError("github", "merge", new Error("gh exploded")).message).toBe("github merge: gh exploded");
});

test("completeChange: every step is journaled as it runs and the change is archived", async () => {
  const repo = join(tmp, "ok-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-OK", branch: "PROJ-OK", checkouts: checkoutsOf([repo]) }),
  );
  await mkdir(join(changeDir(change), basename(repo)), { recursive: true });
  const shell = completionShell({
    worktree: join(tmp, "wt-ok"),
    branch: change.branch,
    pr: approved(7),
  });
  const result = await runWithShell(shell, completeChange(change));
  if (result._tag !== "Done") throw new Error(`expected a completion, got ${result._tag}`);

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
  expect(await Bun.file(join(changeDir(change), "change.json")).exists()).toBe(false);
  expect((await runEffect(readChange(change.id)))?.state).toBe("Completed");
  // Every command went through the scripted seam — no real CLI or server.
  const asked = (shell.calls as ShellCall[]).map((c) => c.cmd.join(" "));
  expect(asked).toContain(`gh pr merge 7 --squash`);
  expect(asked.some((line) => line.startsWith("git worktree remove --force"))).toBe(true);
  // The terminal step is a host-session stop, which does not go through the shell seam: the host
  // owns the ptys, so there is no command to observe here. The stop itself is asserted against a
  // real host through the lifecycle service in test/windowRegistryHost.test.ts.
});

test("contentInMain: contained, cherry-equivalent, and missing content", async () => {
  const repo = join(tmp, "content-repo");
  // Nothing beyond main: contained outright, no cherry needed.
  expect(
    await runWithShell(
      completionShell({ beyond: 0 }),
      contentInMain(repo, "PROJ-x", "origin/main"),
    ),
  ).toBe(true);

  // Commits beyond main, but every one patch-identical upstream: a squash merge.
  expect(
    await runWithShell(
      completionShell({ beyond: 2, cherry: ["- abc123 first", "- def456 second"] }),
      contentInMain(repo, "PROJ-x", "origin/main"),
    ),
  ).toBe(true);

  // One commit with no upstream twin: genuinely unmerged.
  expect(
    await runWithShell(
      completionShell({ beyond: 2, cherry: ["- abc123 first", "+ def456 second"] }),
      contentInMain(repo, "PROJ-x", "origin/main"),
    ),
  ).toBe(false);

  // No base to compare with: unproven, not an error.
  expect(await runWithShell(completionShell({}), contentInMain(repo, "PROJ-x", undefined))).toBe(
    false,
  );
});

test("integrated: the simulated merge is asked once per pair of tips, and again when one moves", async () => {
  const repo = join(tmp, "integrated-repo");
  const branch = "integrated-branch";
  const tree = `${repo}-merged-tree`;
  let baseSha = "aaa";
  const merges: string[] = [];
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    // The cheap proofs fail (two commits, neither patch-identical), so every ask needs the merge.
    if (line.startsWith("git rev-list --count")) return "2";
    if (line.startsWith("git cherry ")) return "+ abc first\n+ def second";
    if (line.startsWith("git merge-tree --write-tree")) {
      merges.push(line);
      return `${tree}\n`;
    }
    if (line === `git rev-parse origin/main ${branch}`) return `${baseSha}\nbbb`;
    if (line.endsWith("^{tree}")) return tree;
    return undefined;
  });
  const ask = (): Promise<boolean> =>
    runWithShell(shell, integrated(repo, branch, "origin/main"));

  expect(await ask()).toBe(true);
  expect(await ask()).toBe(true);
  expect(merges).toHaveLength(1); // the same pair of tips answered from the cache

  // A commit on main is a different pair: the cached answer is not about these commits.
  baseSha = "ccc";
  expect(await ask()).toBe(true);
  expect(merges).toHaveLength(2);
});

test("completionOf: a branch whose content is in main reads as merged without a PR", async () => {
  const repo = join(tmp, "integrated-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-integrated" });
  const shell = completionShell({
    worktree: join(tmp, "wt-integrated"),
    branch: change.branch,
    pr: null,
    beyond: 0,
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    tagged: [],
    toMerge: [],
  });
});

test("completionOf: a closed PR whose content landed elsewhere reads as merged", async () => {
  const repo = join(tmp, "closed-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-closed" });
  const shell = completionShell({
    worktree: join(tmp, "wt-closed"),
    branch: change.branch,
    pr: { ...approved(7), state: "CLOSED" },
    beyond: 1,
    cherry: ["- abc123 landed as a squash"],
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    tagged: [],
    toMerge: [],
  });
});

test("completionOf: an open unapproved PR still gates on an integrated branch", async () => {
  const repo = join(tmp, "open-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-open" });
  const shell = completionShell({
    worktree: join(tmp, "wt-open"),
    branch: change.branch,
    pr: { ...approved(7), reviewDecision: "REVIEW_REQUIRED" },
    beyond: 0,
  });
  const result = await runWithShell(shell, completionOf(change));
  expect(result.ready).toBe(false);
  expect(result.reasons).toEqual([`${basename(repo)}: not approved (review required)`]);
  expect(result.tagged).toEqual([
    { text: `${basename(repo)}: not approved (review required)`, kind: "forceable" },
  ]);
});

test("completionOf: fresh fetches before reading, so a just-merged branch is seen", async () => {
  const repo = join(tmp, "fresh-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-fresh" });
  const shell = completionShell({
    worktree: join(tmp, "wt-fresh"),
    branch: change.branch,
    pr: null,
    beyond: 0,
  });
  const result = await runWithShell(shell, completionOf(change, true));
  expect(result.ready).toBe(true);
  const asked = (shell.calls as ShellCall[]).map((c) => c.cmd.join(" "));
  expect(asked).toContain("git fetch --quiet origin");
});

test("completionOf: a pull request that needs no review is ready to merge", async () => {
  const repo = join(tmp, "noreview-ready-repo");
  const change = changeWith({ checkouts: checkoutsOf([repo]), branch: "PROJ-noreview" });
  const shell = completionShell({
    worktree: join(tmp, "wt-noreview-ready"),
    branch: change.branch,
    // No review decision at all: the repository requires none, so it is queued to merge.
    pr: { ...approved(7), reviewDecision: null },
  });
  expect(await runWithShell(shell, completionOf(change))).toEqual({
    ready: true,
    reasons: [],
    tagged: [],
    toMerge: [{ repo, number: 7 }],
  });
});

test("completeChange: a pull request that needs no review completes and is merged", async () => {
  const repo = join(tmp, "noreview-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-NOREVIEW", branch: "PROJ-NOREVIEW", checkouts: checkoutsOf([repo]) }),
  );
  await mkdir(join(changeDir(change), basename(repo)), { recursive: true });
  const shell = completionShell({
    worktree: join(tmp, "wt-noreview"),
    branch: change.branch,
    pr: { ...approved(7), reviewDecision: null },
  });
  const result = await runWithShell(shell, completeChange(change));
  if (result._tag !== "Done") throw new Error(`expected a completion, got ${result._tag}`);

  expect(result.change.state).toBe("Completed");
  expect(result.notes).toEqual([]);
  // Merged, not skipped: no override was needed for a review nobody required.
  const asked = (shell.calls as ShellCall[]).map((c) => c.cmd.join(" "));
  expect(asked).toContain("gh pr merge 7 --squash");
});

test("completeChange: force completes despite an unapproved PR, and journals the override", async () => {
  const repo = join(tmp, "force-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-FORCE", branch: "PROJ-FORCE", checkouts: checkoutsOf([repo]) }),
  );
  await mkdir(join(changeDir(change), basename(repo)), { recursive: true });
  const shell = completionShell({
    worktree: join(tmp, "wt-force"),
    branch: change.branch,
    pr: { ...approved(7), reviewDecision: "REVIEW_REQUIRED" },
  });
  const result = await runWithShell(shell, completeChange(change, true));
  if (result._tag !== "Done") throw new Error(`expected a completion, got ${result._tag}`);

  expect(result.change.state).toBe("Completed");
  // The unapproved PR is skipped, not merged: nothing mergeable, nothing queued.
  expect(shell.calls.some((c) => c.cmd.join(" ").startsWith("gh pr merge"))).toBe(false);
  expect(result.notes).toEqual([
    `completed with overrides: ${basename(repo)}: not approved (review required)`,
  ]);
  const journal = (await runEffect(progressOf(change.id)))!;
  expect(journal.forced).toBe(true);
  expect(journal.overridden).toEqual([`${basename(repo)}: not approved (review required)`]);
});

test("completeChange: without force an unready change is a refusal, and nothing is written", async () => {
  const repo = join(tmp, "refuse-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-REFUSE", branch: "PROJ-REFUSE", checkouts: checkoutsOf([repo]) }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-refuse"),
    branch: change.branch,
    pr: { ...approved(7), reviewDecision: "REVIEW_REQUIRED" },
  });
  const outcome = await runWithShell(shell, completeChange(change));
  expect(outcome._tag).toBe("NotReady");
  if (outcome._tag !== "NotReady") throw new Error("expected a refusal");
  expect(outcome.refusal.reasons).toEqual([
    { text: `${basename(repo)}: not approved (review required)`, kind: "forceable" },
  ]);
  // A refusal is a dialog, not a completion that started and stopped: no journal for it, and the
  // change is untouched.
  expect(await runEffect(progressOf(change.id))).toBeNull();
  expect((await runEffect(readChange(change.id)))?.state).toBe("Implementation");
});

test("completeChange: force still refuses uncommitted work", async () => {
  const repo = join(tmp, "dirty-force-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-DIRTYFORCE", branch: "PROJ-DIRTYFORCE", checkouts: checkoutsOf([repo]) }),
  );
  await mkdir(join(changeDir(change), basename(repo)), { recursive: true });
  const shell = completionShell({
    worktree: join(tmp, "wt-dirtyforce"),
    branch: change.branch,
    pr: approved(7),
    status: "? half-done.txt\n",
  });
  await expect(runWithShell(shell, completeChange(change, true))).rejects.toThrow(
    /uncommitted changes/,
  );
  expect((await runEffect(readChange(change.id)))?.state).toBe("Implementation");
});

test("completeChange: force still refuses an idea", async () => {
  const idea = await runEffect(createChange({ id: "PROJ-FORCEIDEA", state: "Ideation" }));
  await expect(runEffect(completeChange(idea, true))).rejects.toThrow(/still an idea/);
  expect((await runEffect(readChange(idea.id)))?.state).toBe("Ideation");
});

test("CompleteAnywayDialog: every reason needs its own acknowledge", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CompleteAnywayDialog, canCompleteAnyway } = await import(
    "../apps/web/src/change-page/client/CompleteAnywayDialog.tsx"
  );
  const refusal = {
    reasons: [
      { text: "orders: no pull request", kind: "forceable" as const },
      { text: "api: 2 unpushed commit(s)", kind: "forceable" as const },
    ],
    toMerge: [],
  };
  const html = renderToStaticMarkup(
    createElement(CompleteAnywayDialog, {
      changeId: "PROJ-x",
      refusal,
      busy: false,
      onComplete: () => {},
      onClose: () => {},
    }),
  );
  // Both reasons listed, each with its own checkbox.
  expect(html).toContain("orders: no pull request");
  expect(html).toContain("api: 2 unpushed commit(s)");
  expect(html.match(/type="checkbox"/g)?.length).toBe(2);
  expect(html).toContain("Complete anyway");
  // The gating itself: one acknowledge is not all, and a hard reason never is.
  expect(canCompleteAnyway(refusal.reasons, [false, false])).toBe(false);
  expect(canCompleteAnyway(refusal.reasons, [true, false])).toBe(false);
  expect(canCompleteAnyway(refusal.reasons, [true, true])).toBe(true);
  expect(
    canCompleteAnyway([{ text: "orders: uncommitted changes", kind: "hard" as const }], [true]),
  ).toBe(false);
});

test("CompleteAnywayDialog: hard reasons offer no override button", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CompleteAnywayDialog } = await import(
    "../apps/web/src/change-page/client/CompleteAnywayDialog.tsx"
  );
  const html = renderToStaticMarkup(
    createElement(CompleteAnywayDialog, {
      changeId: "PROJ-x",
      refusal: {
        reasons: [{ text: "orders: uncommitted changes", kind: "hard" as const }],
        toMerge: [],
      },
      busy: false,
      onComplete: () => {},
      onClose: () => {},
    }),
  );
  expect(html).toContain("cannot be overridden");
  expect(html).not.toContain("Complete anyway");
});

test("CompleteAnywayDialog: says which pull requests will still be merged", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CompleteAnywayDialog } = await import(
    "../apps/web/src/change-page/client/CompleteAnywayDialog.tsx"
  );
  const html = renderToStaticMarkup(
    createElement(CompleteAnywayDialog, {
      changeId: "PROJ-x",
      refusal: {
        reasons: [{ text: "orders: no pull request", kind: "forceable" as const }],
        // Merges that are ready still happen, even though the change is forced: the dialog says
        // so rather than letting "not merged stay unmerged" read as every repository.
        toMerge: [{ repo: "/repos/orders", number: 7 }],
      },
      busy: false,
      onComplete: () => {},
      onClose: () => {},
    }),
  );
  expect(html).toContain("will still be merged");
  expect(html).toContain("#7 orders");
});

test("CancelDialog: the confirm waits for the acknowledge the server names", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CancelDialog } = await import("../apps/web/src/change-page/client/CancelDialog.tsx");
  const render = (props: {
    needsForce: string[];
    acked: boolean;
    idea?: boolean;
  }): string =>
    renderToStaticMarkup(
      createElement(CancelDialog, {
        changeId: "PROJ-x",
        idea: props.idea ?? false,
        needsForce: props.needsForce,
        acked: props.acked,
        busy: false,
        onAck: () => {},
        onConfirm: () => {},
        onClose: () => {},
      }),
    );

  // Unpushed commits named and not acknowledged: the only disabled control is the confirm.
  const warned = render({ needsForce: ["orders"], acked: false });
  expect(warned).toContain("orders: commits that were never pushed");
  expect(warned.match(/disabled=""/g)?.length).toBe(1);
  // Acknowledged: nothing is disabled, so confirming can go ahead.
  expect(render({ needsForce: ["orders"], acked: true })).not.toContain("disabled");
  // Nothing to warn about: the confirm is available without an acknowledge.
  expect(render({ needsForce: [], acked: false })).not.toContain("disabled");
  // An idea is discarded, not cancelled.
  expect(render({ needsForce: [], acked: false, idea: true })).toContain("Discard");
});

test("overrideNote: only a finished forced completion says it completed with overrides", async () => {
  const { overrideNote } = await import("../apps/web/src/dashboard/client/CompletionCard.tsx");
  const step = { id: "check", label: "check", state: "done" as const };

  // Finished and forced: the note names what was overridden.
  expect(
    overrideNote({
      startedAt: "t",
      finishedAt: "t",
      forced: true,
      overridden: ["orders: no pull request"],
      steps: [step],
    }),
  ).toBe("Completed with overrides: orders: no pull request.");
  // Stopped: the check step's detail carries the reasons; "completed" would be false.
  expect(
    overrideNote({
      startedAt: "t",
      forced: true,
      overridden: ["orders: no pull request"],
      error: "cannot complete",
      steps: [step],
    }),
  ).toBeUndefined();
  // Not forced, or nothing overridden: no note at all.
  expect(
    overrideNote({ startedAt: "t", finishedAt: "t", overridden: ["x"], steps: [step] }),
  ).toBeUndefined();
  expect(
    overrideNote({ startedAt: "t", finishedAt: "t", forced: true, steps: [step] }),
  ).toBeUndefined();
});

test("completionRefusal/cancelNeedsForce: only a structured 409 opens a dialog", async () => {
  const { completionRefusal, cancelNeedsForce } = await import(
    "../apps/web/src/change-page/client/refusals.ts"
  );
  const failure = (status: number, body: unknown): { status: number; body: unknown } => ({
    status,
    body,
  });

  expect(
    completionRefusal(
      failure(409, {
        reasons: [{ text: "orders: no pull request", kind: "forceable" }],
        toMerge: [{ repo: "/repos/orders", number: 7 }],
      }),
    ),
  ).toEqual({
    reasons: [{ text: "orders: no pull request", kind: "forceable" }],
    toMerge: [{ repo: "/repos/orders", number: 7 }],
  });
  // A 409 without a toMerge still opens the dialog, with nothing to merge.
  expect(completionRefusal(failure(409, { reasons: [{ text: "x", kind: "hard" }] }))).toEqual({
    reasons: [{ text: "x", kind: "hard" }],
    toMerge: [],
  });
  // No reasons, or not a 409: banner news, not a dialog.
  expect(completionRefusal(failure(409, { reasons: [] }))).toBeUndefined();
  expect(
    completionRefusal(failure(400, { reasons: [{ text: "x", kind: "hard" }] })),
  ).toBeUndefined();

  expect(cancelNeedsForce(failure(409, { needsForce: ["orders"] }))).toEqual(["orders"]);
  expect(cancelNeedsForce(failure(409, { needsForce: [] }))).toBeUndefined();
  expect(cancelNeedsForce(failure(400, { needsForce: ["orders"] }))).toBeUndefined();
});

test("retryBody: a retry keeps the forced mode the journal recorded", async () => {
  const { retryBody } = await import("../apps/web/src/dashboard/client/CompletionCard.tsx");
  expect(retryBody(null)).toEqual({});
  expect(retryBody({ startedAt: "t", forced: true, steps: [] })).toEqual({ force: true });
  expect(retryBody({ startedAt: "t", forced: false, steps: [] })).toEqual({});
});

test("completeChange: the readiness check runs once per call", async () => {
  const repo = join(tmp, "once-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-ONCE", branch: "PROJ-ONCE", checkouts: checkoutsOf([repo]) }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-once"),
    branch: change.branch,
    pr: { ...approved(7), reviewDecision: "REVIEW_REQUIRED" },
  });
  const outcome = await runWithShell(shell, completeChange(change));
  expect(outcome._tag).toBe("NotReady");
  const asked = (shell.calls as ShellCall[]).map((c) => c.cmd.join(" "));
  // One readiness check, and one fresh fetch: `completeChange` owns the check now, so the route
  // no longer repeats it.
  expect(asked.filter((line) => line.startsWith("gh pr list"))).toHaveLength(1);
  expect(asked.filter((line) => line === "git fetch --quiet origin")).toHaveLength(1);
});

test("the complete route answers a 409 with the tagged reasons, and force still refuses an idea", async () => {
  const { changeRoutes } = await import("../apps/server/src/change/routes.ts");
  const idea = await runEffect(createChange({ id: "PROJ-ROUTEIDEA", state: "Ideation" }));
  const route = changeRoutes["/api/changes/:id/complete"] as unknown as {
    POST: (req: Request, srv: unknown) => Promise<Response>;
  };
  const call = (body: unknown): Promise<Response> =>
    route.POST(
      Object.assign(
        new Request(`http://127.0.0.1:4000/api/changes/${idea.id}/complete`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        { params: { id: idea.id } },
      ),
      undefined,
    );

  // Without force: the structured refusal the dialog renders, from server truth.
  const refused = await call({});
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    reasons: [{ text: "still an idea: start the work before completing it", kind: "hard" }],
    toMerge: [],
  });

  // With force the 409 is skipped, and the hard refusal stands as a failure — the change is
  // untouched, still an idea.
  const forced = await call({ force: true });
  expect(forced.status).toBe(400);
  expect((await runEffect(readChange(idea.id)))?.state).toBe("Ideation");
});

test("the complete route drives readiness through the scripted CLI", async () => {
  const { withChangeEffect } = await import("../apps/server/src/capabilities/web.ts");
  const { completePost } = await import("../apps/server/src/change/routes.ts");
  const repo = join(tmp, "route-cli-repo");
  const change = await runEffect(
    createChange({ id: "PROJ-ROUTECLI", branch: "PROJ-ROUTECLI", checkouts: checkoutsOf([repo]) }),
  );
  const shell = completionShell({
    worktree: join(tmp, "wt-routecli"),
    branch: change.branch,
    pr: { ...approved(7), reviewDecision: "REVIEW_REQUIRED" },
  });

  // Without force: the route's own error mapping turns the refusal into a 409 whose body is the
  // tagged reasons — the dialog's input, produced from a scripted CLI, all the way through
  // `withChange` (disk read, workspace, Services).
  const refused = await runRouteWithShell(
    shell,
    withChangeEffect(change.id, (c) => completePost(c, {})),
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    reasons: [{ text: `${basename(repo)}: not approved (review required)`, kind: "forceable" }],
    toMerge: [],
  });

  // With force: the reasons are waived, the unapproved PR is skipped rather than merged, and the
  // completion runs to the archive with the override recorded.
  const forced = await runRouteWithShell(
    shell,
    withChangeEffect(change.id, (c) => completePost(c, { force: true })),
  );
  expect(forced.status).toBe(200);
  const body = (await forced.json()) as { change: Change; notes: string[] };
  expect(body.change.state).toBe("Completed");
  expect(body.notes).toEqual([
    `completed with overrides: ${basename(repo)}: not approved (review required)`,
  ]);
  expect((shell.calls as ShellCall[]).some((c) => c.cmd.join(" ").startsWith("gh pr merge"))).toBe(
    false,
  );
});

test("changeActions: the endings are last and apart, and an idea ends by discarding", () => {
  const noop = (): void => {};
  const base = {
    starting: false,
    completing: false,
    cancelling: false,
    completion: undefined,
    onRename: noop,
    onStart: noop,
    onCopyDescription: noop,
    onComplete: noop,
    onCancel: noop,
  };

  // A started change: the name, the copy, then the two endings — Complete and Cancel — the
  // first of them set apart from what can still be undone.
  const active = changeActions({ ...base, idea: false });
  expect(active.map((a) => a.label)).toEqual([
    "Rename change",
    "Copy PR description",
    "Complete change",
    "Cancel change",
  ]);
  expect(active.filter((a) => a.separated).map((a) => a.label)).toEqual(["Complete change"]);
  expect(active.at(-1)?.title).toContain("nothing is merged");

  // The readiness poll is the hover's orientation; the click re-checks.
  const ready = changeActions({
    ...base,
    idea: false,
    completion: { ready: true, reasons: [], tagged: [], toMerge: [] },
  });
  expect(ready.find((a) => a.label === "Complete change")?.title).toBe("Ready to complete");

  // An idea has a third way — starting the work — and its one ending is discarding it.
  const idea = changeActions({ ...base, idea: true });
  expect(idea.map((a) => a.label)).toEqual(["Rename change", "Start work", "Discard idea"]);

  // The busy words follow the flags.
  const busy = changeActions({ ...base, idea: true, starting: true, cancelling: true });
  expect(busy.map((a) => a.label)).toEqual(["Rename change", "Starting…", "Discarding…"]);
  expect(busy.find((a) => a.label === "Discarding…")?.disabled).toBe(true);
});
