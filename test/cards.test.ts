import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Layer } from "effect";
import { clearCache } from "../apps/server/src/capabilities/cache.ts";
import type { Workspace } from "../apps/server/src/workspace/server/index.ts";
import type { Change } from "@corvi/changes/record";
import type { WidgetDto, WidgetItemDto } from "@corvi/contracts/api";
import type { Capabilities } from "../apps/server/src/integrations/api/capabilities.ts";
import type { Card } from "../apps/server/src/integrations/types.ts";
import { BusLive, CacheLive, ChangesLive, GitFactsLive, SettingsLive, extensionStoreLayer } from "../apps/server/src/integrations/services.ts";
import { repoStatusOf, runCard, statusOne } from "../apps/server/src/integrations/effects.ts";
import { integrationRoutes } from "../apps/server/src/integrations/routes.ts";
import { createChange } from "../apps/server/src/change/server/index.ts";
import githubExtension, { githubSummaryContributor, prLooseEnds } from "@corvi/github";
import { mergeReadiness } from "@corvi/github/client";
import azureDevopsExtension, { azureDevopsSummaryContributor } from "@corvi/azure-devops";
import type { Deployed, Service } from "@corvi/contracts/integrations/azure-devops";
import { Shell } from "@corvi/shell";
import { Workspace as WorkspaceTag } from "@corvi/contracts/workspace";
import { workspaceById } from "../apps/server/src/workspace/server/index.ts";
import type { ShellResult } from "../apps/server/src/capabilities/shell.ts";
import { checkoutsOf, fakeShell, forgetRateLimit, runEffect, runWithShell, TestError, testTempDir, withRuntimeConfig, type FakeShell  } from "./helpers.ts";

/**
 * The cards' server half: the GitHub tree and the Azure DevOps tree the dashboard draws, the
 * azure-devops routes its page fetches, and the orchestration that runs a contributed effect.
 * Everything here is driven through the fake Shell (test/helpers.ts) or through in-memory
 * Card/extension stubs, so no `az`, `gh` or `git` process is ever started.
 */

beforeEach(() => {
  clearCache();
  // The gh gate belongs to the tokens and outlives a test: one that scripts a limit clears it
  // first, so it cannot refuse the next test's commands.
  forgetRateLimit();
});

const change = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-1",
  branch: "PROJ-1-thing",
  checkouts: checkoutsOf([]),
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

/**
 * A scripted Shell whose answer may depend on the working directory. fakeShell's response
 * function sees only the command line, but the call it is answering has already been recorded,
 * so the last entry's cwd is the directory this command runs in. That is how two repositories
 * answering the same command differently are told apart.
 */
const shellFor = (
  answer: (line: string, cwd: string | undefined) => string | Partial<ShellResult> | undefined,
): FakeShell => {
  const ref: { shell?: FakeShell } = {};
  const shell = fakeShell((cmd) => answer(cmd.join(" "), ref.shell?.calls.at(-1)?.cwd));
  ref.shell = shell;
  return shell;
};

// --- github: the per-repository tree, the summary and the loose ends -----------------------

const github = githubExtension.cards[0]!;
const azure = azureDevopsExtension.cards[0]!;
const orderRepo = "/repos/example-api";
const orderWt = "/worktrees/example-api";
const branch = "PROJ-1-thing";

const prJson = (number: number, state = "OPEN"): string =>
  JSON.stringify([
    {
      number,
      title: `Fix ${number}`,
      url: `https://github.com/o/example-api/pull/${number}`,
      state,
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    },
  ]);

const checkedOut = (line: string): string | undefined => {
  if (line === "git worktree list --porcelain") {
    return `worktree ${orderWt}\nbranch refs/heads/${branch}\n`;
  }
  if (line === "git status --porcelain=v2 --branch") return `# branch.head ${branch}\n`;
  if (line === "git remote") return "origin";
  if (line === "git symbolic-ref --quiet --short refs/remotes/origin/HEAD") return "origin/main";
  if (line.startsWith("git rev-parse --abbrev-ref --symbolic-full-name")) {
    return `origin/${branch}`;
  }
  return undefined;
};

/** What the azure-devops card needs before it asks for a repository's pipelines: a project to
 * ask in, and the GitHub repository the pipelines name. */
const azureCheckout = (line: string): string | undefined => {
  if (line === "az devops configure -l") return "organization = https://dev.azure.com/org\nproject = proj";
  if (line === "git remote get-url origin") return "git@github.com:o/example-api.git";
  return undefined;
};

test("the github card draws repository > pull request > checks", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) return prJson(5);
    if (line.startsWith("gh api graphql")) {
      return JSON.stringify({
        data: { viewer: { login: "me" }, repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });
    }
    if (line.startsWith("gh pr checks 5 ")) {
      return JSON.stringify([{ name: "build", state: "SUCCESS", bucket: "pass", link: "u1" }]);
    }
    return undefined;
  });

  const items = await runWithShell(shell, github.repoStatus!(change({ checkouts: checkoutsOf([orderRepo]) }), orderRepo));
  expect(items).toHaveLength(1);
  const repoRow = items[0]!;
  expect(repoRow.label).toBe("example-api");
  expect(repoRow.state).toBe("ok");

  const prRow = repoRow.children![0]!;
  expect(prRow.label).toBe("#5 Fix 5");
  expect(prRow.state).toBe("ok");
  expect(prRow.detail).toBe("ready to merge");
  expect(prRow.children!.map((c) => c.label)).toEqual(["build"]);
  expect(shell.calls.some((c) => c.cmd.join(" ").startsWith("gh pr checks 5 "))).toBe(true);
});

test("the azure-devops card draws repository > pipeline > run", async () => {
  const run = {
    id: 100,
    buildNumber: "100",
    status: "completed",
    result: "failed",
    sourceBranch: `refs/heads/${branch}`,
    startTime: "2026-01-01T09:00:00Z",
    finishTime: "2026-01-01T09:05:00Z",
    definition: { id: 10, name: "build-example-api" },
  };
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) return prJson(5);
    if (line.startsWith("gh api graphql")) {
      return JSON.stringify({
        data: { viewer: { login: "me" }, repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });
    }
    const azure = azureCheckout(line);
    if (azure !== undefined) return azure;
    if (line.includes("--resource definitions")) {
      return JSON.stringify({ value: [{ id: 10, name: "build-example-api", path: "\\example-api" }] });
    }
    // Pipelines run on the pull request's merge ref once a PR exists.
    if (line.includes("--branch refs/pull/5/merge")) return JSON.stringify([run]);
    if (line.includes("--branch refs/heads/")) return "[]";
    return undefined;
  });

  const items = await runWithShell(shell, azure.repoStatus!(change({ checkouts: checkoutsOf([orderRepo]) }), orderRepo));
  expect(items).toHaveLength(1);
  const repoRow = items[0]!;
  expect(repoRow.label).toBe("example-api");
  // One red run decides the repository's dot.
  expect(repoRow.state).toBe("error");

  const pipeline = repoRow.children![0]!;
  expect(pipeline.label).toBe("build-example-api");
  expect(pipeline.state).toBe("error");
  expect(pipeline.children![0]).toMatchObject({
    label: "100",
    detail: "failed",
    state: "error",
    // A finished build is as old as its finish time.
    at: "2026-01-01T09:05:00Z",
  });
  expect(shell.calls.some((c) => c.cmd.join(" ").includes("--branch refs/pull/5/merge"))).toBe(true);
});

test("a finished build carries the moment to read, a running one counts in its bar", async () => {
  const run = (over: Record<string, unknown>): Record<string, unknown> => ({
    sourceBranch: `refs/heads/${branch}`,
    definition: { id: 10, name: "build-example-api" },
    ...over,
  });
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) return "[]";
    const azure = azureCheckout(line);
    if (azure !== undefined) return azure;
    if (line.includes("--resource definitions")) {
      return JSON.stringify({ value: [{ id: 10, name: "build-example-api", path: "\\example-api" }] });
    }
    if (line.includes("--branch refs/heads/")) {
      return JSON.stringify([
        run({ id: 101, buildNumber: "101", status: "inProgress", startTime: "2026-01-01T10:00:00Z" }),
        run({
          id: 100,
          buildNumber: "100",
          status: "completed",
          result: "succeeded",
          startTime: "2026-01-01T09:00:00Z",
          finishTime: "2026-01-01T09:05:00Z",
        }),
      ]);
    }
    return undefined;
  });

  const items = await runWithShell(shell, azure.repoStatus!(change({ checkouts: checkoutsOf([orderRepo]) }), orderRepo));
  const runs = items[0]!.children![0]!.children!;
  // Newest first, and only the finished one carries a moment to read: a running build's age is its
  // progress bar, which counts from the same start time.
  expect(runs.map((r) => [r.label, r.at, r.progress?.startedAt])).toEqual([
    ["101", undefined, "2026-01-01T10:00:00Z"],
    ["100", "2026-01-01T09:05:00Z", undefined],
  ]);
});

test("the azure-devops card answers empty when it found no pipelines", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) return prJson(5);
    if (line.startsWith("gh api graphql")) {
      return JSON.stringify({
        data: { viewer: { login: "me" }, repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });
    }
    const azure = azureCheckout(line);
    if (azure !== undefined) return azure;
    if (line.includes("--resource definitions")) return JSON.stringify({ value: [] });
    return undefined;
  });

  // A repository built by GitHub Actions, or by pipelines in another project, has nothing here
  // to show: the GitHub card carries the checks, and this card stays silent.
  const items = await runWithShell(shell, azure.repoStatus!(change({ checkouts: checkoutsOf([orderRepo]) }), orderRepo));
  expect(items).toEqual([]);
});

test("a repository with no worktree reads as no worktree, not as a failed lookup", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    // No worktree line at all: the change has never touched this repository.
    if (line === "git worktree list --porcelain") return "";
    return undefined;
  });

  const items = await runWithShell(shell, github.repoStatus!(change({ checkouts: checkoutsOf([orderRepo]) }), orderRepo));
  const prRow = items[0]!.children![0]!;
  expect(prRow).toMatchObject({ label: "pull request", detail: "no worktree", state: "none" });
  expect(items[0]!.state).toBe("none");
});

test("a pushed branch with no pull request offers to create one", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) return "[]";
    return undefined;
  });

  const items = await runWithShell(shell, github.repoStatus!(change({ checkouts: checkoutsOf([orderRepo]) }), orderRepo));
  const prRow = items[0]!.children![0]!;
  expect(prRow).toMatchObject({ label: "no pull request", detail: "not pushed yet", state: "none" });
  expect(prRow.actions).toEqual([{ id: "create", label: "Push & create PR", arg: orderRepo }]);
});

test("the github create action pushes and opens the pull request", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    return checkedOut(line) ?? undefined;
  });

  await runWithShell(shell, github.run!(change({ checkouts: checkoutsOf([orderRepo]) }), "create", orderRepo));
  const lines = shell.calls.map((c) => c.cmd.join(" "));
  expect(lines).toContain(`git push -u origin ${branch}`);
  expect(lines).toContain("gh pr create --fill");
});

test("the github card refuses an action it does not know, and create without a repository", async () => {
  const shell = fakeShell();
  await expect(
    runWithShell(shell, github.run!(change({ checkouts: checkoutsOf([orderRepo]) }), "bogus", orderRepo)),
  ).rejects.toThrow("unknown github action: bogus");
  await expect(runWithShell(shell, github.run!(change({ checkouts: checkoutsOf([orderRepo]) }), "create", undefined))).rejects.toThrow(
    "repo required",
  );
  expect(shell.calls).toEqual([]);
});

/** A summary-shaped world: the PR, its checks and its threads, plus `active` runs in flight. */
const summaryShell = (active: number, unresolved: number): FakeShell =>
  fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) return prJson(5);
    if (line.startsWith("gh api graphql")) {
      return JSON.stringify({
        data: {
          viewer: { login: "me" },
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: Array.from({ length: unresolved }, () => ({
                  isResolved: false,
                  comments: { nodes: [{ author: { login: "reviewer" } }] },
                })),
              },
            },
          },
        },
      });
    }
    const azure = azureCheckout(line);
    if (azure !== undefined) return azure;
    if (line.includes("--resource definitions")) {
      return JSON.stringify({
        value: active ? [{ id: 10, name: "build-example-api", path: "\\example-api" }] : [],
      });
    }
    if (line.includes("--branch refs/pull/5/merge")) {
      return JSON.stringify(
        Array.from({ length: active }, (_, i) => ({
          id: 101 + i,
          buildNumber: String(101 + i),
          status: "inProgress",
          result: null,
          sourceBranch: `refs/heads/${branch}`,
          definition: { id: 10 },
        })),
      );
    }
    return undefined;
  });

test("the github summary names open comments and takes the checks' verdict", async () => {
  const shell = summaryShell(0, 1);
  const summary = await runWithShell(
    shell,
    githubSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo]) })),
  );
  expect(summary.facts).toEqual([
    { id: "unresolved", label: "1 unresolved comment", state: "warn" },
  ]);
  expect(summary.state).toBe("ok");
});

test("the azure-devops summary counts active pipelines, in the singular and plural", async () => {
  const { clearCache } = await import("../apps/server/src/capabilities/cache.ts");
  const one = await runWithShell(
    summaryShell(1, 0),
    azureDevopsSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo]) })),
  );
  expect(one.facts).toEqual([{ id: "pipelines", label: "1 pipeline active", state: "pending" }]);
  // A pipeline in flight is pending whatever the last checks said.
  expect(one.state).toBe("pending");

  // The `az devops configure` answer and the branch answers are shared per workspace: a
  // second summary in the same process asks again rather than reading the first one's.
  clearCache();
  const two = await runWithShell(
    summaryShell(2, 0),
    azureDevopsSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo]) })),
  );
  expect(two.facts.map((f) => f.label)).toEqual(["2 pipelines active"]);
});

test("the github summary says a limited token once, for the change", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line === "gh api rate_limit") {
      return JSON.stringify({
        resources: { graphql: { reset: Math.floor((Date.now() + 20 * 60_000) / 1_000) } },
      });
    }
    if (line.startsWith("gh pr list --head")) {
      return { code: 1, stderr: "GraphQL: API rate limit already exceeded for user ID 13013300." };
    }
    return undefined;
  });

  // Two repositories behind one token: the overview says it once, and does not read green.
  const summary = await runWithShell(
    shell,
    githubSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo, "/repos/other"]) })),
  );
  expect(summary.facts).toHaveLength(1);
  expect(summary.facts[0]).toMatchObject({ id: "rate-limit", state: "warn" });
  expect(summary.facts[0]!.label).toMatch(/^GitHub rate limit reached; resets at \d\d:\d\d UTC/);
  expect(summary.state).toBe("warn");
  forgetRateLimit();
});

test("the github summary does not report a comment count it could not refresh", async () => {
  const repo = "/repos/summary-gated-threads";
  // A healthy summary warms the display read with one open thread.
  const healthy = summaryShell(0, 1);
  const warm = await runWithShell(
    healthy,
    githubSummaryContributor.facts(change({ checkouts: checkoutsOf([repo]) })),
  );
  expect(warm.facts.map((fact) => fact.id)).toEqual(["unresolved"]);

  // Then the token runs out. The thread count is still in the cache, and stale.
  const limited = fakeShell((cmd) => {
    const line = cmd.join(" ");
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line === "gh api rate_limit") {
      return JSON.stringify({
        resources: { graphql: { reset: Math.floor((Date.now() + 20 * 60_000) / 1_000) } },
      });
    }
    return line.startsWith("gh pr list")
      ? { code: 1, stderr: "GraphQL: API rate limit already exceeded for user ID 13013300." }
      : undefined;
  });
  // A live read is what closes the gate; the display cache stays warm and stale.
  expect(await runWithShell(limited, mergeReadiness(change(), repo))).toMatchObject({
    ready: false,
    kind: "hard",
  });

  const gated = await runWithShell(
    healthy,
    githubSummaryContributor.facts(change({ checkouts: checkoutsOf([repo]) })),
  );
  // The limit's line, and no count beside it: the count is one this summary could not ask for.
  expect(gated.facts.map((fact) => fact.id)).toEqual(["rate-limit"]);
  expect(gated.state).toBe("warn");
  forgetRateLimit();
});

test("an idle inbox and idle pipelines contribute nothing but the idle line", async () => {
  const githubSummary = await runWithShell(
    summaryShell(0, 0),
    githubSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo]) })),
  );
  expect(githubSummary.facts).toEqual([]);
  expect(githubSummary.state).toBe("ok");

  const azureSummary = await runWithShell(
    summaryShell(0, 0),
    azureDevopsSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo]) })),
  );
  expect(azureSummary.facts).toEqual([{ id: "pipelines", label: "pipelines idle", state: "none" }]);
  expect(azureSummary.state).toBeUndefined();
});

test("a vendor being down loses the facts, not the summary", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "git worktree list --porcelain") return "";
    return undefined;
  });
  const summary = await runWithShell(
    shell,
    azureDevopsSummaryContributor.facts(change({ checkouts: checkoutsOf([orderRepo]) })),
  );
  expect(summary.facts).toEqual([{ id: "pipelines", label: "pipelines idle", state: "none" }]);
  expect(summary.state).toBeUndefined();
});

test("loose ends name each open pull request, and a failed lookup contributes nothing", async () => {
  const brokenRepo = "/repos/broken-api";
  const brokenWt = "/worktrees/broken-api";
  const goneRepo = "/repos/gone-api";
  const shell = shellFor((line, cwd) => {
    if (line === "git worktree list --porcelain") {
      if (cwd === orderRepo) return `worktree ${orderWt}\nbranch refs/heads/${branch}\n`;
      if (cwd === brokenRepo) return `worktree ${brokenWt}\nbranch refs/heads/${branch}\n`;
      return "";
    }
    const checked = checkedOut(line);
    if (checked !== undefined) return checked;
    if (line.startsWith("gh pr list --head")) {
      if (cwd === orderWt) return prJson(5);
      if (cwd === brokenWt) return { code: 1, stderr: "no network" };
      return "[]";
    }
    return undefined;
  });

  const ends = await runWithShell(
    shell,
    prLooseEnds(change({ checkouts: checkoutsOf([orderRepo, brokenRepo, goneRepo]) })),
  );
  // One line per repository that has a pull request; a down vendor and a missing worktree are
  // not loose ends worth failing a cancellation over.
  expect(ends).toEqual(["example-api #5 is still open"]);
});

// --- azure-devops: the routes' body validation and workspace routing ----------------------

const azureRoutes = azureDevopsExtension.routes;
const servicesRoute = azureRoutes.find((r) => r.path === "/services")!;
const versionsRoute = azureRoutes.find((r) => r.path === "/services/:service/versions")!;
const deployRoute = azureRoutes.find((r) => r.path === "/services/:service/deploy")!;

/** Everything an extension effect may require, with the scripted Shell in place of the live one
 * — the same layer github.test.ts builds, because a route handler is typed as requiring the whole
 * capability union even when this route only shells out. The workspace travels with the layer:
 * the dispatcher provides it from the request's `workspace` parameter, so the test names the
 * workspace the handler should run as. */
const extLayer = (shell: FakeShell, workspaceId?: string): Layer.Layer<Capabilities> =>
  Layer.mergeAll(
    Layer.succeed(Shell, shell),
    CacheLive,
    SettingsLive,
    BusLive,
    ChangesLive, GitFactsLive,
    Layer.succeed(WorkspaceTag, workspaceById(workspaceId)),
    extensionStoreLayer("test"),
  );

const runRoute = <A, E>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, Capabilities>,
  workspaceId?: string,
): Promise<Result.Result<A, E>> =>
  Effect.runPromise(Effect.result(Effect.provide(effect, extLayer(shell, workspaceId))));

const jsonOf = async <A>(result: Result.Result<Response, A>): Promise<unknown> => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success.json();
};

test("the services route answers for a workspace that enabled azure-devops", async () => {
  const shell = fakeShell();
  const workspace: Workspace = {
    id: "acme",
    name: "Acme",
    settings: {
      extensionSettings: {
        "azure-devops": { organization: "https://dev.azure.com/acme", project: "acme-proj" },
      },
    },
  };
  const result = await withRuntimeConfig({ workspaces: [workspace] }, () =>
    runRoute(
      shell,
      servicesRoute.handler(
        new Request("http://localhost/api/ext/azure-devops/services?workspace=acme"),
        {},
      ),
      "acme",
    ),
  );
  expect(await jsonOf(result)).toEqual({
    services: [],
    error: "no pipelines found — is `az` logged in?",
  });
  // The named context's organisation and project reach the CLI, so a second client is not read
  // through the first client's login.
  const asks = shell.calls.map((c) => c.cmd.join(" "));
  expect(asks.some((line) => line.includes("--organization https://dev.azure.com/acme"))).toBe(true);
  expect(asks.some((line) => line.includes("--project acme-proj"))).toBe(true);
});

test("an absent workspace parameter means the first context", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "az devops configure -l") return "organization = https://dev.azure.com/org\nproject = proj";
    if (line.startsWith("az pipelines list ")) return "[]";
    return undefined;
  });
  const result = await withRuntimeConfig(
    {
      workspaces: [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ],
    },
    () =>
      runRoute(
        shell,
        servicesRoute.handler(new Request("http://localhost/api/ext/azure-devops/services"), {}),
        "first",
      ),
  );
  // No workspace parameter means the request runs as the first workspace; the route answers
  // whatever Azure says there rather than refusing for lack of a named context.
  expect(await jsonOf(result)).toEqual({
    services: [],
    error: "no pipelines found — is `az` logged in?",
  });
});

test("the versions route reads the deploy runs of a *-app service", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 7, name: "deploy-example-app", path: "\\example-app" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 7 ")) {
      return JSON.stringify([
        {
          id: 1,
          buildNumber: "b1",
          status: "completed",
          result: "succeeded",
          sourceBranch: "refs/heads/main",
          startTime: "2026-01-01T09:00:00Z",
          finishTime: "2026-01-01T09:05:00Z",
          templateParameters: { environment: "accept", imageTag: "v9" },
        },
      ]);
    }
    return undefined;
  });

  const result = await runRoute(
    shell,
    versionsRoute.handler(
      new Request("http://localhost/api/ext/azure-devops/services/example-app/versions"),
      { service: "example-app" },
    ),
  );
  expect(await jsonOf(result)).toEqual([
    expect.objectContaining({ runId: 1, version: "v9", deployedTo: ["accept"] }),
  ]);
});

// --- azure-devops: the deployments page's read semantics -----------------------------------

/** One deploy run as `az pipelines runs list` reports it: a version given to one environment, in
 * the parameters, which is where `latestFor` reads it from. */
const deployRun = (
  id: number,
  status: string,
  version: string,
  environment: string,
): Record<string, unknown> => ({
  id,
  buildNumber: `run-${id}`,
  status,
  result: status === "completed" ? "succeeded" : null,
  sourceBranch: "refs/heads/main",
  startTime: "2026-01-01T09:00:00Z",
  finishTime: status === "completed" ? "2026-01-01T09:10:00Z" : null,
  templateParameters: { environment, imageTag: version },
});

type ServicesBody = { services: Service[]; error?: string };

/** One service's row, and one environment of it, in a `/services` answer. */
const serviceOn = (body: ServicesBody, service: string): Service | undefined =>
  body.services.find((s) => s.name === service);

const environmentOn = (
  body: ServicesBody,
  service: string,
  environment = "accept",
): Deployed | undefined =>
  serviceOn(body, service)?.environments.find((e) => e.environment === environment);

const versionOn = (
  body: ServicesBody,
  service: string,
  environment = "accept",
): string | undefined => environmentOn(body, service, environment)?.version;

/** How often one pipeline's runs were listed, split by which question was asked: the deploy runs
 * themselves, or the completed history behind the duration estimate. */
const runsAsks = (shell: FakeShell, pipelineId: number, status = ""): number =>
  shell.calls.filter((c) =>
    c.cmd.join(" ").startsWith(`az pipelines runs list --pipeline-ids ${pipelineId} ${status}--top`)
  ).length;

const pipelinesAsks = (shell: FakeShell): number =>
  shell.calls.filter((c) => c.cmd.join(" ").startsWith("az pipelines list ")).length;

const configuredShell = (
  respond: (line: string) => string | Partial<ShellResult> | undefined,
): FakeShell =>
  fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "az devops configure -l") {
      return "organization = https://dev.azure.com/org\nproject = proj";
    }
    return respond(line);
  });

const readServices = async (shell: FakeShell, query = ""): Promise<ServicesBody> =>
  await jsonOf(await runRoute(shell, servicesRoute.handler(
    new Request(`http://localhost/api/ext/azure-devops/services${query}`),
    {},
  ))) as ServicesBody;

const readVersions = async (
  shell: FakeShell,
  service: string,
  query = "",
): Promise<{ runId: number; version?: string; deployedTo: string[] }[]> =>
  await jsonOf(await runRoute(shell, versionsRoute.handler(
    new Request(`http://localhost/api/ext/azure-devops/services/${service}/versions${query}`),
    { service },
  ))) as { runId: number; version?: string; deployedTo: string[] }[];

test("a poll reads again only the pipeline that is deploying", async () => {
  // What the deploys look like, driven by this test rather than by how often it has been asked.
  let alpha = deployRun(5, "inProgress", "v1", "accept");
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([
        { id: 101, name: "deploy-alpha", path: "\\alpha" },
        { id: 102, name: "deploy-beta", path: "\\beta" },
      ]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 101 --top 50")) {
      return JSON.stringify([alpha]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 102 --top 50")) {
      return JSON.stringify([deployRun(7, "completed", "v7", "accept")]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 101 --status completed")) {
      // Two ten-minute runs: the typical duration behind the bar.
      return JSON.stringify([
        deployRun(1, "completed", "v1", "accept"),
        deployRun(2, "completed", "v1", "accept"),
      ]);
    }
    return undefined;
  });

  const first = await readServices(shell);
  expect(environmentOn(first, "alpha")).toMatchObject({
    state: "pending",
    version: "v1",
    // The history question behind the bar, and its answer on the row.
    expectedMs: 10 * 60_000,
  });
  expect(runsAsks(shell, 101, "--status completed ")).toBe(1);

  // A settled environment has no bar, so nothing asks how long that pipeline takes.
  expect(environmentOn(first, "beta")).toMatchObject({ state: "ok", version: "v7" });
  expect(environmentOn(first, "beta")!.expectedMs).toBeUndefined();
  expect(runsAsks(shell, 102, "--status completed ")).toBe(0);

  // The deploy lands between polls. The next poll reads the pipeline that was moving once more,
  // and the settled one not at all — a delta, so how cold the first poll's cache was cannot
  // flatter or spoil the claim.
  const before = [runsAsks(shell, 101), runsAsks(shell, 102)];
  alpha = deployRun(6, "completed", "v2", "accept");
  const second = await readServices(shell);
  expect([
    runsAsks(shell, 101) - before[0]!,
    runsAsks(shell, 102) - before[1]!,
  ]).toEqual([1, 0]);
  // And the watch is what moved the row.
  expect(environmentOn(second, "alpha")).toMatchObject({ state: "ok", version: "v2" });

  // What the watch read is what the cache now holds: a third poll costs nothing at all, and still
  // serves the finished deploy rather than reading it again.
  const settled = [runsAsks(shell, 101), runsAsks(shell, 102)];
  const third = await readServices(shell);
  expect([
    runsAsks(shell, 101) - settled[0]!,
    runsAsks(shell, 102) - settled[1]!,
  ]).toEqual([0, 0]);
  expect(environmentOn(third, "alpha")).toMatchObject({ state: "ok", version: "v2" });

  // Names are not deployments: the pipeline list was read once for every poll.
  expect(pipelinesAsks(shell)).toBe(1);
});

test("after the first, a poll of a deploying pipeline costs one call", async () => {
  // The pipeline never stops deploying, so every poll watches it. The first poll pays for a cold
  // read and its own watch; every later one is served from what the previous watch left in the
  // cache and pays for its own watch alone. An implementation that emptied the cache on a watch
  // would pay for both, which is the whole difference here.
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 161, name: "deploy-alpha", path: "\\alpha" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 161 --top 50")) {
      return JSON.stringify([deployRun(5, "inProgress", "v1", "accept")]);
    }
    return undefined;
  });

  for (let poll = 0; poll < 3; poll++) {
    expect(environmentOn(await readServices(shell), "alpha")).toMatchObject({
      state: "pending",
      version: "v1",
    });
  }
  // Three polls: the cold read, and one watch each.
  expect(runsAsks(shell, 161)).toBe(4);
});

test("only the environment that is deploying carries a duration", async () => {
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 121, name: "deploy-mixed", path: "\\mixed" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 121 --top 50")) {
      return JSON.stringify([
        deployRun(3, "completed", "v1", "accept"),
        deployRun(4, "inProgress", "v2", "production"),
      ]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 121 --status completed")) {
      return JSON.stringify([
        deployRun(1, "completed", "v1", "accept"),
        deployRun(2, "completed", "v1", "accept"),
      ]);
    }
    return undefined;
  });

  const body = await readServices(shell);
  expect(environmentOn(body, "mixed", "accept")).toMatchObject({ state: "ok", version: "v1" });
  expect(environmentOn(body, "mixed", "accept")!.expectedMs).toBeUndefined();
  expect(environmentOn(body, "mixed", "production")).toMatchObject({
    state: "pending",
    version: "v2",
    expectedMs: 10 * 60_000,
  });
  // One history query serves both environments of the pipeline, and only the pending one uses it.
  expect(runsAsks(shell, 121, "--status completed ")).toBe(1);
});

test("a failed live read leaves a deploying environment where it was", async () => {
  let answer: string | Partial<ShellResult> = JSON.stringify([
    deployRun(5, "inProgress", "v1", "accept"),
  ]);
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 131, name: "deploy-alpha", path: "\\alpha" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 131 --top 50")) return answer;
    if (line.startsWith("az pipelines runs list --pipeline-ids 131 --status completed")) {
      return JSON.stringify([
        deployRun(1, "completed", "v1", "accept"),
        deployRun(2, "completed", "v1", "accept"),
      ]);
    }
    return undefined;
  });

  expect(environmentOn(await readServices(shell), "alpha")).toMatchObject({ state: "pending" });

  // The watch's own CLI call fails. A failure is not "this pipeline has no runs": the row keeps
  // what was last known about it, version and detail (`deploying v1`, not `never deployed`).
  answer = { code: 1, stderr: "az: connection reset" };
  const second = await readServices(shell);
  expect(environmentOn(second, "alpha")).toMatchObject({
    environment: "accept",
    state: "pending",
    version: "v1",
    detail: "deploying v1",
    expectedMs: 10 * 60_000,
  });

  // And when the CLI answers again the deploy that finished in the meantime shows, rather than
  // being hidden behind a cached empty answer.
  answer = JSON.stringify([deployRun(6, "completed", "v2", "accept")]);
  expect(environmentOn(await readServices(shell), "alpha")).toMatchObject({
    state: "ok",
    version: "v2",
  });
});

test("refresh=1 reads every deploy pipeline again, and the answer it finds is served", async () => {
  let alphaVersion = "v1";
  let betaVersion = "v7";
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([
        { id: 111, name: "deploy-alpha", path: "\\alpha" },
        { id: 112, name: "deploy-beta", path: "\\beta" },
      ]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 111 --top 50")) {
      return JSON.stringify([deployRun(9, "completed", alphaVersion, "accept")]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 112 --top 50")) {
      return JSON.stringify([deployRun(10, "completed", betaVersion, "accept")]);
    }
    return undefined;
  });

  const cached = await readServices(shell);
  expect([versionOn(cached, "alpha"), versionOn(cached, "beta")]).toEqual(["v1", "v7"]);
  expect([runsAsks(shell, 111), runsAsks(shell, 112)]).toEqual([1, 1]);
  // A poll right after serves the same answer without asking again.
  expect(versionOn(await readServices(shell), "alpha")).toBe("v1");
  expect([runsAsks(shell, 111), runsAsks(shell, 112)]).toEqual([1, 1]);

  // Deploys nobody on this page started landed in the meantime; only a refresh asks about them.
  alphaVersion = "v2";
  betaVersion = "v8";
  const refreshed = await readServices(shell, "?refresh=1");
  expect([versionOn(refreshed, "alpha"), versionOn(refreshed, "beta")]).toEqual(["v2", "v8"]);
  expect([runsAsks(shell, 111), runsAsks(shell, 112)]).toEqual([2, 2]);
  // The pipeline list is not a deployment: it stays cached, refresh or not.
  expect(pipelinesAsks(shell)).toBe(1);
});

test("a failed refresh leaves the rows as they were", async () => {
  let failing = false;
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 141, name: "deploy-alpha", path: "\\alpha" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 141 --top 50")) {
      return failing
        ? { code: 1, stderr: "az: connection reset" }
        : JSON.stringify([deployRun(5, "completed", "v1", "accept")]);
    }
    return undefined;
  });

  expect(versionOn(await readServices(shell), "alpha")).toBe("v1");
  const before = runsAsks(shell, 141);

  // A refresh is a live read; this one failed, so the answer it cannot give must not replace the
  // one we have.
  failing = true;
  const refreshed = await readServices(shell, "?refresh=1");
  expect(runsAsks(shell, 141) - before).toBe(1);
  expect(environmentOn(refreshed, "alpha")).toMatchObject({ state: "ok", version: "v1" });

  // And nothing was cached as "no runs": the next poll serves v1 without asking.
  const afterFailure = runsAsks(shell, 141);
  expect(versionOn(await readServices(shell), "alpha")).toBe("v1");
  expect(runsAsks(shell, 141) - afterFailure).toBe(0);
});

test("a refresh reads a deploying pipeline once, and asks for its duration once", async () => {
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 151, name: "deploy-alpha", path: "\\alpha" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 151 --top 50")) {
      return JSON.stringify([deployRun(5, "inProgress", "v1", "accept")]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 151 --status completed")) {
      return JSON.stringify([
        deployRun(1, "completed", "v1", "accept"),
        deployRun(2, "completed", "v1", "accept"),
      ]);
    }
    return undefined;
  });

  const first = await readServices(shell, "?refresh=1");
  // One live read: not a cached shot followed by a live one.
  expect(runsAsks(shell, 151)).toBe(1);
  expect(environmentOn(first, "alpha")).toMatchObject({
    state: "pending",
    expectedMs: 10 * 60_000,
  });
  expect(runsAsks(shell, 151, "--status completed ")).toBe(1);

  // One live read per refresh; the duration behind the bar is cached for five minutes.
  const again = await readServices(shell, "?refresh=1");
  expect(runsAsks(shell, 151)).toBe(2);
  expect(runsAsks(shell, 151, "--status completed ")).toBe(1);
  expect(environmentOn(again, "alpha")!.expectedMs).toBe(10 * 60_000);
});

test("the versions route reads the runs again only when the dialog asks it to", async () => {
  let newerBuild = false;
  let deployVersion = "v31";
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([
        { id: 21, name: "build-example-api", path: "\\example-api" },
        { id: 22, name: "deploy-example-api", path: "\\example-api" },
      ]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 21 --top 50")) {
      const older = {
        id: 31,
        buildNumber: "b31",
        status: "completed",
        result: "succeeded",
        sourceBranch: "refs/heads/main",
        startTime: "2026-01-01T09:00:00Z",
        finishTime: "2026-01-01T09:10:00Z",
        // The version comes from this pipeline's logs, so the run has to name it.
        definition: { id: 21 },
      };
      return newerBuild
        ? JSON.stringify([{ ...older, id: 32, buildNumber: "b32" }, older])
        : JSON.stringify([older]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 22 --top 50")) {
      return JSON.stringify([deployRun(41, "completed", deployVersion, "accept")]);
    }
    if (line.includes("--area pipelines --resource logs")) {
      return JSON.stringify({ logs: [{ id: 1 }] });
    }
    if (line.includes("--area build --resource logs")) {
      return JSON.stringify({
        value: [line.includes("buildId=32") ? "Version is: 'v32'" : "Version is: 'v31'"],
      });
    }
    return undefined;
  });

  expect(
    (await readVersions(shell, "example-api")).map((v) => [v.runId, v.version, v.deployedTo]),
  ).toEqual([[31, "v31", ["accept"]]]);
  expect([runsAsks(shell, 21), runsAsks(shell, 22)]).toEqual([1, 1]);

  // A second open without the flag is the same question: the cache answers without reading `az`.
  expect((await readVersions(shell, "example-api")).map((v) => v.runId)).toEqual([31]);
  expect([runsAsks(shell, 21), runsAsks(shell, 22)]).toEqual([1, 1]);

  // The dialog opening asks live instead. A build that finished a moment ago is offered now, and
  // where it already is comes from the deploy runs just as freshly: accept has moved on to v32.
  newerBuild = true;
  deployVersion = "v32";
  expect(
    (await readVersions(shell, "example-api", "?refresh=1")).map((v) => [
      v.runId,
      v.version,
      v.deployedTo,
    ]),
  ).toEqual([[32, "v32", ["accept"]], [31, "v31", []]]);
  expect([runsAsks(shell, 21), runsAsks(shell, 22)]).toEqual([2, 2]);
  // The pipeline list is not a run: it stays cached.
  expect(pipelinesAsks(shell)).toBe(1);
});

test("the versions route reads a *-app service's deploy runs again when asked", async () => {
  let newer = false;
  const shell = configuredShell((line) => {
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 7, name: "deploy-example-app", path: "\\example-app" }]);
    }
    if (line.startsWith("az pipelines runs list --pipeline-ids 7 --top 50")) {
      return JSON.stringify([
        ...(newer ? [deployRun(2, "completed", "v10", "accept")] : []),
        deployRun(1, "completed", "v9", "accept"),
      ]);
    }
    return undefined;
  });

  expect((await readVersions(shell, "example-app")).map((v) => [v.runId, v.version])).toEqual([
    [1, "v9"],
  ]);
  // A second open without the flag answers from the cache.
  expect((await readVersions(shell, "example-app")).map((v) => v.runId)).toEqual([1]);
  expect(runsAsks(shell, 7)).toBe(1);

  newer = true;
  expect(
    (await readVersions(shell, "example-app", "?refresh=1")).map((v) => [v.runId, v.version]),
  ).toEqual([[2, "v10"], [1, "v9"]]);
  expect(runsAsks(shell, 7)).toBe(2);
});

test("the deploy route refuses a body that is not JSON", async () => {
  const result = await runRoute(
    fakeShell(),
    deployRoute.handler(
      new Request("http://localhost/api/ext/azure-devops/services/example-api/deploy", {
        method: "POST",
        body: "not json",
      }),
      { service: "example-api" },
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("BadRequestError");
    expect(result.failure.message.length).toBeGreaterThan(0);
  }
});

test("the deploy route refuses a body missing the version or the environment, or not an object at all", async () => {
  const call = (body: unknown): Promise<Result.Result<Response, unknown>> =>
    runRoute(
      fakeShell(),
      deployRoute.handler(
        new Request("http://localhost/api/ext/azure-devops/services/example-api/deploy", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
        { service: "example-api" },
      ),
    );

  // An empty object, a missing field and a body that is not an object at all are the same
  // caller's mistake: the version and the environment have to be there.
  for (const body of [{}, { version: "v1" }, { environment: "accept" }, null]) {
    const result = await call(body);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Error);
      expect((result.failure as Error).message).toBe("version and environment required");
    }
  }
});

test("the deploy route passes a complete body to the promotion-guarded deploy", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    if (line === "az devops configure -l") return "organization = https://dev.azure.com/org\nproject = proj";
    if (line.startsWith("az pipelines list ")) return "[]";
    return undefined;
  });
  const call = (body: unknown): Promise<Result.Result<Response, unknown>> =>
    runRoute(
      shell,
      deployRoute.handler(
        new Request("http://localhost/api/ext/azure-devops/services/example-api/deploy", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
        { service: "example-api" },
      ),
    );

  // The known environment gets as far as the pipeline lookup; the unknown one is refused first.
  const known = await call({ version: "v1", environment: "accept" });
  expect(Result.isFailure(known)).toBe(true);
  if (Result.isFailure(known)) expect((known.failure as Error).message).toBe("no deploy pipeline for example-api");

  const unknown = await call({ version: "v1", environment: "staging" });
  expect(Result.isFailure(unknown)).toBe(true);
  if (Result.isFailure(unknown)) expect((unknown.failure as Error).message).toBe("unknown environment: staging");
});

// --- effects: provisioning, status/repoStatus, actions and the read-only finished change ----

/** A card whose effects are pure, so the orchestration in effects.ts is what is under test. */
const card = (over: Partial<Card> = {}): Card => ({ title: "Card", ...over });

const widget = (over: Partial<WidgetDto> = {}): WidgetDto => ({
  integration: "test",
  title: "Card",
  state: "ok",
  summary: "fine",
  items: [
    {
      label: "row",
      actions: [{ id: "act", label: "Do it" }],
      menu: [{ id: "open", label: "Open" }],
      children: [{ label: "child", actions: [{ id: "child-act", label: "Child" }] }],
    },
  ],
  ...over,
});

test("statusOne passes a live card through unchanged", async () => {
  const modelled = widget();
  const result = await runEffect(
    statusOne("test", card({ status: () => Effect.succeed(modelled) }), change()),
  );
  expect(result).toEqual(modelled);
});

test("a card with no whole-widget status fails as a red card that says so", async () => {
  const result = await runEffect(statusOne("test", card(), change()));
  expect(result).toMatchObject({
    integration: "test",
    title: "Card",
    state: "error",
    summary: "Card reports per repository",
    items: [],
  });
});

test("a failing status is a red card carrying the message", async () => {
  const result = await runEffect(
    statusOne("test", card({ status: () => Effect.fail(new TestError({ message: "vendor down" })) }), change()),
  );
  expect(result).toMatchObject({ state: "error", summary: "vendor down" });
});

test("a finished change's widget keeps its rows but loses every action", async () => {
  const modelled = widget();
  const finished = change({ state: "Completed", completedAt: "2026-01-02T00:00:00Z" });
  const result = await runEffect(
    statusOne("test", card({ status: () => Effect.succeed(modelled) }), finished),
  );
  const row = result.items[0]!;
  // Reading, not acting: the child's action goes too. The ⋯ menu still opens the repository.
  expect(row.actions).toBeUndefined();
  expect(row.menu).toEqual([{ id: "open", label: "Open" }]);
  expect(row.children![0]!.actions).toBeUndefined();
  // The rest of the widget is untouched.
  expect(result).toMatchObject({ integration: "test", state: "ok", summary: "fine" });
});

test("repoStatusOf returns a card's rows for the repository, or a red row naming it", async () => {
  const repo = "/repos/example-api";
  const rows: WidgetItemDto[] = [{ label: "worktree", actions: [{ id: "a", label: "A" }] }];
  const fromCard = await runEffect(
    repoStatusOf("test", card({ repoStatus: () => Effect.succeed(rows) }), change(), repo),
  );
  expect(fromCard).toEqual(rows);

  const noRepo = await runEffect(repoStatusOf("test", card(), change(), repo));
  expect(noRepo).toEqual([
    { label: "example-api", detail: "Card has no per-repository view", state: "error" },
  ]);

  const failed = await runEffect(
    repoStatusOf("test", card({ repoStatus: () => Effect.fail(new TestError({ message: "gh said no" })) }), change(), repo),
  );
  expect(failed).toEqual([{ label: "example-api", detail: "gh said no", state: "error" }]);
});

test("a finished change's repository rows lose their actions too", async () => {
  const repo = "/repos/example-api";
  const finished = change({ state: "Cancelled", completedAt: "2026-01-02T00:00:00Z" });
  const result = await runEffect(
    repoStatusOf(
      "test",
      card({
        repoStatus: () =>
          Effect.succeed([
            { label: "worktree", actions: [{ id: "a", label: "A" }], children: [{ label: "c" }] },
          ]),
      }),
      finished,
      repo,
    ),
  );
  expect(result[0]!.actions).toBeUndefined();
  expect(result[0]!.children).toEqual([{ label: "c" }]);
});

test("runCard performs the action with its argument", async () => {
  const seen: { action: string; arg: string | undefined }[] = [];
  const result = await runEffect(
    runCard(
      "test",
      card({
        run: (_change, action, arg) => {
          seen.push({ action, arg });
          return Effect.void;
        },
      }),
      change(),
      "act",
      "the-arg",
    ),
  );
  expect(result).toBeUndefined();
  expect(seen).toEqual([{ action: "act", arg: "the-arg" }]);
});

test("a card with no actions fails rather than silently doing nothing", async () => {
  await expect(runEffect(runCard("test", card(), change(), "act", undefined))).rejects.toThrow(
    "Card has no actions",
  );
});

// --- the cards route's own surface ------------------------------------------------------------

// The cards route reads a real change, so its tests own a change root of their own.
let cardsRoot: string;

beforeAll(async () => {
  cardsRoot = await testTempDir("cards-editable");
  process.env.CORVI_ROOT = join(cardsRoot, "changes");
});

afterAll(async () => {
  await rm(cardsRoot, { recursive: true, force: true });
});

/** The cards route as server.ts mounts it, called with the path parameter Bun would have
 * filled in (the pattern test/changeTabs.test.ts sets for the guarded routes). */
const cardsOf = async (id: string): Promise<{ name: string; editable?: boolean }[]> => {
  const route = integrationRoutes["/api/changes/:id/cards"] as unknown as {
    GET: (req: Request, srv: unknown) => Promise<Response>;
  };
  const req = Object.assign(new Request(`http://127.0.0.1:4000/api/changes/${id}/cards`), {
    params: { id },
  });
  const response = await route.GET(req, undefined);
  expect(response.status).toBe(200);
  return (await response.json()) as { name: string; editable?: boolean }[];
};

test("the cards route says which cards are editable", async () => {
  await runEffect(
    createChange({ id: "PROJ-CARDS-EDIT", state: "Ideation", checkouts: checkoutsOf([]) }),
  );
  const editable = Object.fromEntries(
    (await cardsOf("PROJ-CARDS-EDIT")).map((c) => [c.name, c.editable]),
  );
  // The cards whose client half ships an editor — the repository list and the two ticket links.
  expect(editable["git"]).toBe(true);
  expect(editable["jira"]).toBe(true);
  expect(editable["github-issues"]).toBe(true);
  // And a card without one says so, rather than leaving the page to guess.
  expect(editable["azure-devops"]).toBe(false);
});
