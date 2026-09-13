import { beforeEach, expect, test } from "bun:test";
import { checkItems, groupChecks, type Check } from "../src/extensions/github/checks.ts";
import type { Change } from "../src/domain/change.ts";
import type { WidgetItem } from "../src/domain/widget.ts";
import { clearCache } from "../src/capabilities/cache.ts";
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
