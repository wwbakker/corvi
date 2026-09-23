import { beforeEach, expect, test } from "bun:test";
import {
  activeRuns,
  averageDuration,
  buildUrl,
  expectedDuration,
  folderFor,
  pipelineItems,
  refsFor,
  runState,
  versionInLines,
  versionOf,
  type Run,
} from "@corvi/azure-devops/pipelines";
import { azDefaults, azFor, type Az } from "@corvi/azure-devops/azure";
import type { Change } from "../apps/server/src/domain/change.ts";
import type { WidgetItem, WidgetState } from "../apps/server/src/domain/widget.ts";
import { clearCache } from "../apps/server/src/capabilities/cache.ts";
import { runtimeConfig } from "../apps/server/src/workspace/server/index.ts";
import { checkoutsOf, fakeShell, runWithShell  } from "./helpers.ts";

/** Every effect below goes through the shared cache and the contract's capabilities, and every
 * test starts from a cold one so a key one test warmed cannot answer for another. */
beforeEach(() => {
  clearCache();
});

const az = (key = "test"): Az => ({
  key,
  args: [],
  organization: "https://dev.azure.com/org",
  project: "proj",
});

const runRow = (
  id: number,
  status: string,
  result?: string | null,
  definitionId?: number,
  over: Partial<Run> = {},
): Run => ({
  id,
  buildNumber: String(id),
  status,
  result: result ?? null,
  sourceBranch: "refs/heads/PROJ-1-thing",
  ...(definitionId !== undefined ? { definition: { id: definitionId } } : {}),
  ...over,
});

const change: Change = {
  id: "PROJ-1",
  branch: "PROJ-1-thing",
  checkouts: checkoutsOf(["/repos/repo"]),
  createdAt: "2026-01-01T00:00:00Z",
};

test("runState reads a queued or running build as pending and every other completion as a problem", () => {
  expect(runState(runRow(1, "inProgress"))).toBe("pending");
  expect(runState(runRow(1, "notStarted"))).toBe("pending");
  expect(runState(runRow(1, "completed", "succeeded"))).toBe("ok");
  expect(runState(runRow(1, "completed", "partiallySucceeded"))).toBe("warn");
  expect(runState(runRow(1, "completed", "canceled"))).toBe("warn");
  // A completed run with no result, and any result Azure does not name, are failures.
  expect(runState(runRow(1, "completed"))).toBe("error");
  expect(runState(runRow(1, "completed", "failed"))).toBe("error");
  expect(runState(runRow(1, "completed", null))).toBe("error");
});

test("refsFor adds the pull request merge ref only once a pull request exists", () => {
  expect(refsFor("PROJ-1-thing")).toEqual(["refs/heads/PROJ-1-thing"]);
  expect(refsFor("PROJ-1-thing", 42)).toEqual([
    "refs/pull/42/merge",
    "refs/heads/PROJ-1-thing",
  ]);
  // Pull request zero is not a pull request.
  expect(refsFor("PROJ-1-thing", 0)).toEqual(["refs/heads/PROJ-1-thing"]);
});

test("folderFor names the pipeline folder after the repository itself", () => {
  expect(folderFor("/repos/acme/example-api")).toBe("\\example-api");
  // A trailing separator is not the repository name.
  expect(folderFor("/repos/acme/example-api/")).toBe("\\example-api");
});

test("averageDuration averages the finished runs and ignores everything else", () => {
  const finished = (id: number, start: string, finish: string): Run =>
    runRow(id, "completed", "succeeded", undefined, { startTime: start, finishTime: finish });

  expect(averageDuration([])).toBeUndefined();
  // No times at all, and a zero-length run, contribute nothing.
  expect(averageDuration([runRow(1, "inProgress")])).toBeUndefined();
  expect(
    averageDuration([finished(1, "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z")]),
  ).toBeUndefined();
  // A finish before the start is not a duration.
  expect(
    averageDuration([finished(1, "2026-01-01T10:00:00Z", "2026-01-01T09:00:00Z")]),
  ).toBeUndefined();

  expect(
    averageDuration([
      finished(1, "2026-01-01T10:00:00Z", "2026-01-01T10:10:00Z"), // 10m
      finished(2, "2026-01-01T09:00:00Z", "2026-01-01T09:20:00Z"), // 20m
      runRow(3, "inProgress"), // still running, no contribution
    ]),
  ).toBe(15 * 60_000);

  // Fractional milliseconds round to the nearest whole one.
  const ms = (id: number, duration: number): Run =>
    finished(id, "2026-01-01T10:00:00.000Z", new Date(Date.parse("2026-01-01T10:00:00.000Z") + duration).toISOString());
  expect(averageDuration([ms(1, 1000), ms(2, 1000), ms(3, 1002)])).toBe(1001);
});

test("versionInLines reads the version out of the line a pipeline prints it on", () => {
  expect(versionInLines(["Version is: '20260818.4'"])).toBe("20260818.4");
  // The image reference is deliberately loose: docker prints the full reference before the tag.
  expect(versionInLines(["pushing manifest for my.registry.io/team/app:20260818.12"])).toBe(
    "20260818.12",
  );
  expect(versionInLines(["Built and pushed image as registry/app:20260818.4"])).toBe("20260818.4");
  expect(versionInLines(["nothing to see", "still nothing"])).toBeUndefined();
  // Line order wins, not pattern order: the first line with any version answers.
  expect(versionInLines(["pushing manifest for app:20260818.9", "Version is: '20260818.1'"])).toBe(
    "20260818.9",
  );
  // The first pattern that matches wins within one line, regardless of where it sits in it.
  expect(versionInLines(["Built and pushed image as app:20260818.1 Version is: '20260818.2'"])).toBe(
    "20260818.2",
  );
});

test("buildUrl needs both the organisation and the project, and encodes the project", () => {
  expect(
    buildUrl(7, {
      key: "k",
      args: [],
      organization: "https://dev.azure.com/org",
      project: "My Project",
    }),
  ).toBe("https://dev.azure.com/org/My%20Project/_build/results?buildId=7");
  // Half an address is no address.
  expect(
    buildUrl(7, { key: "k", args: [], organization: "https://dev.azure.com/org" }),
  ).toBeUndefined();
  expect(buildUrl(7, { key: "k", args: [], project: "proj" })).toBeUndefined();
});

test("azDefaults reads az devops configure, and reads it once", async () => {
  const shell = fakeShell({
    "az devops configure -l": [
      "organization = https://dev.azure.com/fresh",
      "project = FreshProj",
      "unrelated = ignored",
    ].join("\n"),
  });

  // Nothing configured anywhere beats what the CLI itself holds: no bag on the shared config,
  // no legacy flat field in the file it was loaded from, no environment override. (An earlier
  // test file may have left any of those behind, so all three are cleared first rather than
  // assumed — including the file, which is pointed at an empty one and reloaded.)
  const beforeBag = runtimeConfig().extensionSettings;
  const beforeConfig = process.env.CORVI_CONFIG;
  const beforeOrg = process.env.CORVI_AZURE_ORG;
  const beforeProject = process.env.CORVI_AZURE_PROJECT;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { reloadConfigSync } = await import("../apps/server/src/workspace/server/index.ts");
  const empty = await mkdtemp(join(tmpdir(), "corvi-az-empty-"));
  runtimeConfig().extensionSettings = undefined;
  delete process.env.CORVI_AZURE_ORG;
  delete process.env.CORVI_AZURE_PROJECT;
  process.env.CORVI_CONFIG = join(empty, "runtimeConfig().json");
  await Bun.write(process.env.CORVI_CONFIG, "{}");
  reloadConfigSync();
  try {
    const first = await runWithShell(shell, azDefaults());
    expect(first).toEqual({
      organization: "https://dev.azure.com/fresh",
      project: "FreshProj",
    });

    // The shared cache answers the second ask: the CLI runs once no matter how many
    // workspaces fall back to it.
    const calls = shell.calls.length;
    const second = await runWithShell(shell, azDefaults());
    expect(second).toEqual(first);
    expect(shell.calls.length).toBe(calls);
  } finally {
    runtimeConfig().extensionSettings = beforeBag;
    if (beforeConfig === undefined) delete process.env.CORVI_CONFIG;
    else process.env.CORVI_CONFIG = beforeConfig;
    if (beforeOrg === undefined) delete process.env.CORVI_AZURE_ORG;
    else process.env.CORVI_AZURE_ORG = beforeOrg;
    if (beforeProject === undefined) delete process.env.CORVI_AZURE_PROJECT;
    else process.env.CORVI_AZURE_PROJECT = beforeProject;
    await rm(empty, { recursive: true, force: true });
    reloadConfigSync();
  }
});

test("azFor names the workspace's own Azure DevOps when it has one", async () => {
  const workspace = {
    id: "client",
    name: "Client",
    extensionSettings: {
      "azure-devops": {
        organization: "https://dev.azure.com/client",
        project: "ClientProj",
      },
    },
  };
  const result = await runWithShell(fakeShell(), azFor(workspace));
  expect(result).toMatchObject({
    key: "client",
    organization: "https://dev.azure.com/client",
    project: "ClientProj",
  });
  // The organisation and project are passed explicitly, in that order, so a second client is
  // possible with one `az` login.
  expect(result.args).toEqual([
    "--organization",
    "https://dev.azure.com/client",
    "--project",
    "ClientProj",
  ]);
});

test("azFor falls back to what az devops configure holds", async () => {
  const fallback = await runWithShell(fakeShell(), azDefaults());
  const workspace = { id: "own", name: "Own" };
  const result = await runWithShell(fakeShell(), azFor(workspace));
  expect(result.organization).toBe(fallback.organization);
  expect(result.project).toBe(fallback.project);
  // Only the values that exist are passed on a command line.
  expect(result.args).toEqual([
    ...(fallback.organization ? ["--organization", fallback.organization] : []),
    ...(fallback.project ? ["--project", fallback.project] : []),
  ]);
});

test("expectedDuration averages the completed runs az reports for a pipeline", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines runs list --pipeline-ids 501")) {
      return JSON.stringify([
        runRow(1, "completed", "succeeded", 501, {
          startTime: "2026-01-01T10:00:00Z",
          finishTime: "2026-01-01T10:10:00Z",
        }),
        runRow(2, "completed", "succeeded", 501, {
          startTime: "2026-01-01T09:00:00Z",
          finishTime: "2026-01-01T09:20:00Z",
        }),
      ]);
    }
    return undefined;
  });
  expect(await runWithShell(shell, expectedDuration(az(), 501))).toBe(15 * 60_000);
});

test("a failed or unreadable duration query has no estimate, not an error", async () => {
  const failed = fakeShell((cmd) =>
    cmd.join(" ").startsWith("az pipelines runs list --pipeline-ids 502")
      ? { code: 1, stderr: "azure is down" }
      : undefined,
  );
  expect(await runWithShell(failed, expectedDuration(az(), 502))).toBeUndefined();

  const garbage = fakeShell((cmd) =>
    cmd.join(" ").startsWith("az pipelines runs list --pipeline-ids 503") ? "not json" : undefined,
  );
  expect(await runWithShell(garbage, expectedDuration(az(), 503))).toBeUndefined();
});

test("expectedDuration asks az for as much history as CORVI_AZURE_HISTORY names", async () => {
  const original = process.env.CORVI_AZURE_HISTORY;
  process.env.CORVI_AZURE_HISTORY = "3";
  try {
    let seen = "";
    const shell = fakeShell((cmd) => {
      seen = cmd.join(" ");
      return JSON.stringify([]);
    });
    expect(await runWithShell(shell, expectedDuration(az(), 504))).toBeUndefined();
    expect(seen).toContain("--top 3");
    expect(seen).toContain("--status completed");
  } finally {
    if (original === undefined) delete process.env.CORVI_AZURE_HISTORY;
    else process.env.CORVI_AZURE_HISTORY = original;
  }
});

test("versionOf asks nothing for a run that did not succeed", async () => {
  const shell = fakeShell();
  expect(await runWithShell(shell, versionOf(runRow(700001, "inProgress", null, 9), "proj"))).toBeUndefined();
  expect(await runWithShell(shell, versionOf(runRow(700002, "completed", "failed", 9), "proj"))).toBeUndefined();
  expect(shell.calls).toEqual([]);
});

test("versionOf finds the version in the newest log that printed one, and remembers it", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.includes("--area pipelines --resource logs")) {
      return JSON.stringify({ logs: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    }
    if (line.includes("--area build --resource logs")) {
      // Newest log first: only the middle one carries the version.
      return JSON.stringify({
        value: line.includes("logId=2") ? ["Version is: '20260818.7'"] : ["nothing here"],
      });
    }
    return undefined;
  });
  const run = runRow(700003, "completed", "succeeded", 77);
  expect(await runWithShell(shell, versionOf(run, "proj"))).toBe("20260818.7");

  // A finished run's logs never change, so the second lookup is answered from the cache.
  const calls = shell.calls.length;
  expect(await runWithShell(shell, versionOf(run, "proj"))).toBe("20260818.7");
  expect(shell.calls.length).toBe(calls);
});

test("versionOf finds nothing when no log printed a version", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.includes("--area pipelines --resource logs")) {
      return JSON.stringify({ logs: [{ id: 5 }] });
    }
    if (line.includes("--area build --resource logs")) {
      return JSON.stringify({ value: ["built without a version"] });
    }
    return undefined;
  });
  expect(await runWithShell(shell, versionOf(runRow(700004, "completed", "succeeded", 78), "proj"))).toBeUndefined();
});

test("versionOf finds nothing when the log listing fails or the run names no pipeline", async () => {
  const failing = fakeShell((cmd) =>
    cmd.join(" ").includes("--area pipelines --resource logs") ? { code: 1, stderr: "no logs" } : undefined,
  );
  expect(await runWithShell(failing, versionOf(runRow(700005, "completed", "succeeded", 79), "proj"))).toBeUndefined();

  const noPipeline = fakeShell();
  expect(await runWithShell(noPipeline, versionOf(runRow(700006, "completed", "succeeded"), "proj"))).toBeUndefined();
  expect(noPipeline.calls).toEqual([]);
});

test("versionOf finds nothing when reading a log fails", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.includes("--area pipelines --resource logs")) {
      return JSON.stringify({ logs: [{ id: 1 }] });
    }
    if (line.includes("--area build --resource logs")) return { code: 1, stderr: "log gone" };
    return undefined;
  });
  expect(
    await runWithShell(shell, versionOf(runRow(700007, "completed", "succeeded", 80), "proj")),
  ).toBeUndefined();
});

test("activeRuns counts only in-flight runs of this repository's pipelines", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([
        { id: 11, name: "build-a", path: "\\repo" },
        { id: 12, name: "build-b", path: "\\repo" },
      ]);
    }
    if (line.startsWith("az pipelines runs list --branch")) {
      return JSON.stringify([
        runRow(31, "inProgress", null, 11),
        runRow(30, "completed", "succeeded", 11),
        // Another service's pipeline, and a run that names no pipeline at all.
        runRow(29, "inProgress", null, 99),
        runRow(28, "inProgress"),
      ]);
    }
    return undefined;
  });
  expect(await runWithShell(shell, activeRuns(change, "/repos/repo"))).toBe(1);
});

test("activeRuns asks about the merge ref too once there is a pull request", async () => {
  const asked: string[] = [];
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([{ id: 11, name: "build-a", path: "\\repo" }]);
    }
    if (line.startsWith("az pipelines runs list --branch")) {
      asked.push(line);
      return JSON.stringify([]);
    }
    return undefined;
  });
  expect(await runWithShell(shell, activeRuns(change, "/repos/repo", 7))).toBe(0);
  expect(asked.some((l) => l.includes("--branch refs/pull/7/merge"))).toBe(true);
  expect(asked.some((l) => l.includes("--branch refs/heads/PROJ-1-thing"))).toBe(true);
});

test("activeRuns reads a failed query as no runs, not as an error", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([{ id: 11, name: "build-a", path: "\\repo" }]);
    }
    if (line.startsWith("az pipelines runs list --branch")) {
      return { code: 1, stderr: "azure is down\nextra" };
    }
    return undefined;
  });
  expect(await runWithShell(shell, activeRuns(change, "/repos/repo"))).toBe(0);
});

test("pipelineItems nests each pipeline's newest runs under it", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([
        { id: 201, name: "build-a", path: "\\repo" },
        { id: 202, name: "build-b", path: "\\repo" },
        { id: 203, name: "build-c", path: "\\repo" },
      ]);
    }
    if (line.startsWith("az pipelines runs list --branch")) {
      return JSON.stringify([
        runRow(406, "inProgress", null, 202, { startTime: "2026-01-01T10:00:00Z" }),
        runRow(405, "completed", "succeeded", 201),
        runRow(404, "completed", "failed", 201),
        runRow(403, "completed", "succeeded", 999), // not one of this folder's pipelines
      ]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 202")) {
      return JSON.stringify([
        runRow(1, "completed", "succeeded", 202, {
          startTime: "2026-01-01T09:00:00Z",
          finishTime: "2026-01-01T09:20:00Z",
        }),
      ]);
    }
    // Version log lookups (only made when a project is known) find nothing.
    if (line.includes("--area pipelines --resource logs")) return JSON.stringify({ logs: [] });
    if (line.includes("--area build --resource logs")) return JSON.stringify({ value: [] });
    return undefined;
  });

  const { items, count } = await runWithShell(shell, pipelineItems(change, "/repos/repo"));
  expect(count).toBe(3);
  expect(items.map((i) => i.label)).toEqual(["build-a", "build-b", "build-c"]);

  const [a, b, c] = items as [WidgetItem, WidgetItem, WidgetItem];
  // The newest run decides the pipeline's own dot; the older failure keeps its own.
  expect(a.state).toBe("ok");
  expect(a.detail).toBeUndefined();
  expect(a.children!.map((child) => child.label)).toEqual(["405", "404"]);
  expect(a.children!.map((child) => child.state)).toEqual(["ok", "error"] satisfies WidgetState[]);
  expect(a.children![0]!.detail).toBe("succeeded");
  expect(a.children![1]!.detail).toBe("failed");

  // A running pipeline carries a progress bar and the estimate expectedDuration returned.
  expect(b.state).toBe("pending");
  expect(b.children![0]!.detail).toBe("inProgress");
  expect(b.children![0]!.progress).toEqual({
    startedAt: "2026-01-01T10:00:00Z",
    expectedMs: 20 * 60_000,
  });

  // A pipeline with nothing to show says so rather than looking like a green one.
  expect(c.state).toBe("none");
  expect(c.detail).toBe("no runs for this branch");
  expect(c.children).toEqual([]);
});

test("pipelineItems appends the version a successful build printed", async () => {
  const before = runtimeConfig().extensionSettings;
  // A project is what makes a version lookup worth attempting at all.
  runtimeConfig().extensionSettings = { "azure-devops": { project: "proj" } };
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([{ id: 601, name: "build-a", path: "\\repo" }]);
    }
    if (line.startsWith("az pipelines runs list --branch")) {
      return JSON.stringify([runRow(701, "completed", "succeeded", 601)]);
    }
    if (line.includes("--area pipelines --resource logs")) {
      return JSON.stringify({ logs: [{ id: 1 }] });
    }
    if (line.includes("--area build --resource logs")) {
      return JSON.stringify({ value: ["Version is: '20260818.5'"] });
    }
    return undefined;
  });

  try {
    const { items } = await runWithShell(
      shell,
      pipelineItems(
        { ...change, workspace: undefined },
        "/repos/repo",
      ),
    );
    expect(items[0]!.children![0]!.detail).toBe("succeeded · 20260818.5");
  } finally {
    runtimeConfig().extensionSettings = before;
  }
});

test("pipelineItems names the pull request when there is one and no runs", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([{ id: 301, name: "build-a", path: "\\repo" }]);
    }
    if (line.startsWith("az pipelines runs list")) return JSON.stringify([]);
    return undefined;
  });
  const { items, count } = await runWithShell(shell, pipelineItems(change, "/repos/repo", 7));
  expect(count).toBe(0);
  expect(items[0]).toMatchObject({
    label: "build-a",
    detail: "no runs for this pull request or branch",
    state: "none",
  });
});

test("pipelineItems answers empty when it found no pipelines", async () => {
  const shell = fakeShell((cmd) =>
    cmd.join(" ").startsWith("az pipelines list --folder-path") ? JSON.stringify([]) : JSON.stringify([]),
  );
  const { items, count } = await runWithShell(shell, pipelineItems(change, "/repos/repo"));
  expect(count).toBe(0);
  expect(items).toEqual([]);
});

test("pipelineItems turns a failed runs query into one error row", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list --folder-path")) {
      return JSON.stringify([{ id: 401, name: "build-a", path: "\\repo" }]);
    }
    if (line.startsWith("az pipelines runs list --branch")) {
      return { code: 1, stderr: "azure is down\nextra" };
    }
    return undefined;
  });
  const { items, count } = await runWithShell(shell, pipelineItems(change, "/repos/repo"));
  expect(count).toBe(0);
  expect(items).toEqual([{ label: "pipelines", detail: "azure is down", state: "error" }]);
});
