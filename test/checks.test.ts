import { beforeEach, expect, test } from "bun:test";
import { checkItems, groupChecks, type Check } from "../src/extensions/ci/checks.ts";
import {
  describeStack,
  mergeStacked,
  outcomeOf,
  pollResult,
  stackOnBase,
  stackRequest,
  type MergeResult,
} from "../src/integrations/stacks.ts";
import type { Change, WidgetItem } from "../src/types.ts";
import { clearCache } from "../src/cache.ts";
import { fakeShell, runWithShell } from "./helpers.ts";

beforeEach(() => clearCache());

const check = (name: string, bucket: string, link?: string, startedAt?: string): Check => ({
  name,
  state: bucket,
  bucket,
  link,
  startedAt,
});

test("groupChecks groups by the name before the bracket, and a lone check is its own row", () => {
  expect(groupChecks([])).toEqual([]);

  const items = groupChecks([
    check("build (CI App @scope/one-app)", "fail", "u1"),
    check("build (CI Affected Build)", "pending", "u2", "2026-01-01T00:00:00Z"),
    check("build", "pass", "u3"),
    check("sonarqube", "pass", "u4"),
  ]);
  expect(items.map((i) => i.label)).toEqual(["build", "sonarqube"]);

  const [build, sonar] = items as [WidgetItem, WidgetItem];
  // A failure anywhere in the group colours the group, and the counts say what is going on.
  expect(build.state).toBe("error");
  expect(build.detail).toBe("3 checks · 1 failing · 1 running");
  // More than one member means opening the row, so the link belongs on the children.
  expect(build.url).toBeUndefined();
  expect(build.children!.map((c) => c.label)).toEqual([
    "CI App @scope/one-app",
    "CI Affected Build",
    "overall",
  ]);
  expect(build.children!.map((c) => c.state)).toEqual(["error", "pending", "ok"]);
  // Only a pending child carries progress, and it is the one with a start time.
  expect(build.children![0]!.progress).toBeUndefined();
  expect(build.children![1]!.progress).toEqual({ startedAt: "2026-01-01T00:00:00Z" });

  // A single check is its own row already: no children, and it keeps its own link.
  expect(sonar).toMatchObject({ state: "ok", url: "u4", detail: "1 check" });
  expect(sonar.children).toBeUndefined();
});

test("groupChecks takes the worst state in the group, and a group with no verdict reads as none", () => {
  const only = (bucket: string): WidgetItem => groupChecks([check("x (a)", bucket)])[0]!;
  expect(only("fail").state).toBe("error");
  expect(only("pending").state).toBe("pending");
  expect(only("pass").state).toBe("ok");
  expect(only("skipping").state).toBe("none");
  // GitHub's cancel maps to warn for the individual check, but a group of nothing but cancelled
  // checks has no verdict to report.
  expect(only("cancel").state).toBe("none");
  expect(only("brand-new-bucket").state).toBe("none");

  // A cancelled check beside a passing one keeps its own warn state among the children.
  const mixed = groupChecks([check("g", "pass"), check("g (c)", "cancel")])[0]!;
  expect(mixed.state).toBe("ok");
  expect(mixed.children!.map((c) => c.state)).toEqual(["ok", "warn"]);
  expect(mixed.detail).toBe("2 checks");
});

test("groupChecks names a group's own check 'overall' and labels the rest by what is left", () => {
  const items = groupChecks([
    check("owner.frontend-app", "pass"),
    check("owner.frontend-app (CI App @scope/one-app)", "pass"),
  ]);
  expect(items[0]!.children!.map((c) => c.label)).toEqual([
    "overall",
    "CI App @scope/one-app",
  ]);
  // The detail is the check's own state, in GitHub's lowercase word.
  expect(items[0]!.children![0]!.detail).toBe("pass");
});

test("checkItems reads gh pr checks and groups them, even when the CLI exits non-zero", async () => {
  const shell = fakeShell((cmd) => {
    if (cmd.join(" ").startsWith("gh pr checks 7")) {
      // A failing check is a result, not an error: the exit code is ignored.
      return {
        code: 1,
        stdout: JSON.stringify([
          { name: "build (job 1)", state: "FAILURE", bucket: "fail", link: "u1" },
          { name: "build (job 2)", state: "SUCCESS", bucket: "pass", link: "u2" },
          { name: "sonarqube", state: "SUCCESS", bucket: "pass", link: "u3" },
        ]),
      };
    }
    return undefined;
  });

  const change: Change = {
    id: "PROJ-1",
    branch: "PROJ-1-thing",
    repos: ["/repos/repo"],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const items = await runWithShell(shell, checkItems(change, "/repos/repo", 7));
  expect(items.map((i) => i.label)).toEqual(["build", "sonarqube"]);
  expect(items[0]!.state).toBe("error");
  expect(items[0]!.detail).toBe("2 checks · 1 failing");
  expect(items[1]!.state).toBe("ok");
  expect(items[1]!.url).toBe("u3");
});

test("checkItems reads an empty or unreadable answer as no checks", async () => {
  const change: Change = {
    id: "PROJ-1",
    branch: "PROJ-1-thing",
    repos: ["/repos/repo"],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh pr checks 8")) return "";
    if (line.startsWith("gh pr checks 9")) return "not json";
    return undefined;
  });
  expect(await runWithShell(shell, checkItems(change, "/repos/repo", 8))).toEqual([]);
  expect(await runWithShell(shell, checkItems(change, "/repos/repo", 9))).toEqual([]);
});

test("checkItems asks the pull request's checks in the change's worktree when there is one", async () => {
  const change: Change = {
    id: "PROJ-1",
    branch: "PROJ-1-thing",
    repos: ["/repos/repo"],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "git worktree list --porcelain") {
      return "worktree /tmp/wt-PROJ-1\nbranch refs/heads/PROJ-1-thing\n";
    }
    if (line.startsWith("gh pr checks 10")) return "[]";
    return undefined;
  });

  await runWithShell(shell, checkItems(change, "/repos/repo", 10));
  const gh = shell.calls.find((c) => c.cmd[0] === "gh")!;
  expect(gh.cwd).toBe("/tmp/wt-PROJ-1");
  expect(gh.cmd).toEqual([
    "gh",
    "pr",
    "checks",
    "10",
    "--json",
    "name,state,bucket,link,startedAt,completedAt",
  ]);
});

test("stackRequest appends to an existing stack, or starts one with both pull requests", () => {
  expect(stackRequest("o/r", 4, 5)).toEqual([
    "repos/o/r/stacks",
    "-F",
    "pull_requests[]=4",
    "-F",
    "pull_requests[]=5",
  ]);
  expect(stackRequest("o/r", 4, 5, 12)).toEqual([
    "repos/o/r/stacks/12/add",
    "-F",
    "pull_requests[]=5",
  ]);
});

test("describeStack reads as its position, not its number", () => {
  expect(describeStack({ number: 12, size: 3, position: 2 })).toBe("2 of 3 in stack #12");
});

test("outcomeOf reads every ending GitHub offers", () => {
  expect(outcomeOf({ status: "pending" })).toEqual({ waiting: true });
  expect(outcomeOf({ status: "merged" })).toEqual({ waiting: false });
  // Enqueued is an ending too: the merge queue owns the stack from there.
  expect(outcomeOf({ status: "enqueued" })).toEqual({
    waiting: false,
    note: "added to the merge queue",
  });
  expect(outcomeOf({ status: "failed", details: { message: "conflict on main" } })).toEqual({
    waiting: false,
    error: "conflict on main",
  });
  // An unknown word, and a failure without a message, both read as a failure.
  expect(outcomeOf({ status: "who-knows" } as unknown as MergeResult)).toEqual({
    waiting: false,
    error: "the merge failed",
  });
  expect(outcomeOf({ status: "failed" })).toEqual({ waiting: false, error: "the merge failed" });
});

test("pollResult is a result only when the poll succeeded and the answer has a status", () => {
  const body = JSON.stringify({ status: "pending", details: { uuid: "u" } });
  expect(pollResult(0, body)).toEqual({ status: "pending", details: { uuid: "u" } });
  expect(pollResult(1, body)).toBeUndefined();
  expect(pollResult(0, "not json")).toBeUndefined();
  // A status-less answer is no result, which is what keeps a hiccup from reading as pending.
  expect(pollResult(0, JSON.stringify({ details: { uuid: "u" } }))).toBeUndefined();
  // An unknown status still decodes; outcomeOf decides what to do with it.
  const unknownStatus = pollResult(0, JSON.stringify({ status: "weird" })) as
    | { status: string }
    | undefined;
  expect(unknownStatus?.status).toBe("weird");
});

test("mergeStacked submits and returns without polling when the merge already landed", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh api --method PUT") && line.includes("/merge-async")) {
      return JSON.stringify({ status: "merged", details: { uuid: "u" } });
    }
    return undefined;
  });
  expect(await runWithShell(shell, mergeStacked("/repo", "o/r", 5))).toBeUndefined();
  expect(shell.calls.filter((c) => c.cmd.join(" ").includes("merge-async"))).toHaveLength(1);
});

test("mergeStacked reports a stack handed to the merge queue", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ").includes("merge-async")
      ? JSON.stringify({ status: "enqueued", details: { uuid: "u" } })
      : undefined,
  );
  expect(await runWithShell(shell, mergeStacked("/repo", "o/r", 6))).toBe(
    "added to the merge queue",
  );
});

test("mergeStacked says what GitHub said when the submit itself failed", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ").startsWith("gh api --method PUT")
      ? { code: 1, stderr: "not a stack" }
      : undefined,
  );
  await expect(runWithShell(shell, mergeStacked("/repo", "o/r", 7))).rejects.toThrow(
    /could not start the merge of #7: not a stack/,
  );
});

test("mergeStacked polls an already-started merge and reports its failure", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh api --method PUT")) {
      // 409: a merge request already exists, and its uuid comes back all the same.
      return {
        code: 409,
        stdout: JSON.stringify({ status: "pending", details: { uuid: "u9" } }),
      };
    }
    if (line.includes("merge-async/u9")) {
      return JSON.stringify({ status: "failed", details: { message: "conflict on main" } });
    }
    return undefined;
  });
  await expect(runWithShell(shell, mergeStacked("/repo", "o/r", 8))).rejects.toThrow(
    /could not merge #8: conflict on main/,
  );
});

test("mergeStacked asks the pull request itself when a poll is unreadable", async () => {
  const merged = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh api --method PUT")) {
      return JSON.stringify({ status: "pending", details: { uuid: "u1" } });
    }
    if (line.includes("merge-async/u1")) return "garbage";
    if (line === "gh api repos/o/r/pulls/9 -q .merged") return "true";
    return undefined;
  });
  expect(await runWithShell(merged, mergeStacked("/repo", "o/r", 9))).toBeUndefined();

  const lost = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh api --method PUT")) {
      return JSON.stringify({ status: "pending", details: { uuid: "u1" } });
    }
    if (line.includes("merge-async/u1")) return { code: 1, stderr: "502 bad gateway\nextra" };
    if (line === "gh api repos/o/r/pulls/10 -q .merged") return "false";
    return undefined;
  });
  await expect(runWithShell(lost, mergeStacked("/repo", "o/r", 10))).rejects.toThrow(
    /lost track of the merge of #10: 502 bad gateway/,
  );
});

test("mergeStacked gives up on a merge still pending after five minutes unless it landed", async () => {
  // The deadline is wall-clock, so it is the wall clock that is moved here rather than the
  // Effect clock: no test should wait five minutes for a decision this small.
  const realNow = Date.now;
  let now = realNow();
  Date.now = (): number => (now += 6 * 60_000);
  try {
    const stillRunning = fakeShell((cmd) => {
      const line = cmd.join(" ");
      if (line.startsWith("gh api --method PUT")) {
        return JSON.stringify({ status: "pending", details: { uuid: "u" } });
      }
      if (line === "gh api repos/o/r/pulls/11 -q .merged") return "false";
      return undefined;
    });
    await expect(runWithShell(stillRunning, mergeStacked("/repo", "o/r", 11))).rejects.toThrow(
      /still running after 5m/,
    );

    const landed = fakeShell((cmd) => {
      const line = cmd.join(" ");
      if (line.startsWith("gh api --method PUT")) {
        return JSON.stringify({ status: "pending", details: { uuid: "u" } });
      }
      if (line === "gh api repos/o/r/pulls/12 -q .merged") return "true";
      return undefined;
    });
    expect(await runWithShell(landed, mergeStacked("/repo", "o/r", 12))).toBeUndefined();
  } finally {
    Date.now = realNow;
  }
});

test("stackOnBase appends to the stack the base pull request is already in", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh repo view")) return "o/r";
    if (line.startsWith("gh pr list --head base")) return JSON.stringify([{ number: 4 }]);
    if (line.startsWith("gh api repos/o/r/pulls/4 ")) return JSON.stringify({ stack: { number: 12 } });
    return undefined;
  });

  await runWithShell(shell, stackOnBase("/repo", "base", 5));
  const post = shell.calls.find((c) => c.cmd.includes("POST"))!;
  expect(post.cmd).toEqual([
    "gh",
    "api",
    "-X",
    "POST",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    "repos/o/r/stacks/12/add",
    "-F",
    "pull_requests[]=5",
  ]);
});

test("stackOnBase starts a new stack when the base pull request has none", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh repo view")) return "o/r";
    if (line.startsWith("gh pr list --head base")) return JSON.stringify([{ number: 4 }]);
    if (line.startsWith("gh api repos/o/r/pulls/4 ")) return JSON.stringify({});
    return undefined;
  });

  await runWithShell(shell, stackOnBase("/repo", "base", 5));
  const post = shell.calls.find((c) => c.cmd.includes("POST"))!;
  expect(post.cmd).toEqual([
    "gh",
    "api",
    "-X",
    "POST",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    "repos/o/r/stacks",
    "-F",
    "pull_requests[]=4",
    "-F",
    "pull_requests[]=5",
  ]);
});

test("stackOnBase does nothing when there is no pull request below", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("gh repo view")) return "o/r";
    if (line.startsWith("gh pr list --head base")) return "[]";
    return undefined;
  });
  await runWithShell(shell, stackOnBase("/repo", "base", 5));
  expect(shell.calls.some((c) => c.cmd.includes("POST"))).toBe(false);
});

test("stackOnBase does nothing when the repository is unknown", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ").startsWith("gh repo view") ? "" : undefined,
  );
  await runWithShell(shell, stackOnBase("/repo", "base", 5));
  // The base branch is looked up before the empty repository is noticed, but nothing is stacked.
  expect(shell.calls.map((c) => c.cmd[0])).toEqual(["gh", "gh"]);
  expect(shell.calls.some((c) => c.cmd.includes("POST"))).toBe(false);
});

test("stackOnBase warns rather than failing when GitHub refuses the stack", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown): void => {
    warnings.push(String(message));
  };
  try {
    const shell = fakeShell((cmd) => {
      const line = cmd.join(" ");
      if (line.startsWith("gh repo view")) return "o/r";
      if (line.startsWith("gh pr list --head base")) return JSON.stringify([{ number: 4 }]);
      if (line.startsWith("gh api repos/o/r/pulls/4 ")) return JSON.stringify({});
      if (line.includes("POST")) return { code: 1, stderr: "stacks are not enabled" };
      return undefined;
    });
    await runWithShell(shell, stackOnBase("/repo", "base", 5));
  } finally {
    console.warn = original;
  }
  expect(warnings.join("\n")).toContain("could not stack #5 onto #4: stacks are not enabled");
});
