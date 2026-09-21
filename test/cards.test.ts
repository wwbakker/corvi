import { beforeEach, expect, test } from "bun:test";
import { Effect, Either, Layer } from "effect";
import { clearCache } from "../src/capabilities/cache.ts";
import { runtimeConfig, type Workspace } from "../src/workspace/server/index.ts";
import type { Change } from "../src/domain/change.ts";
import type { Widget, WidgetItem } from "../src/domain/widget.ts";
import type { Capabilities } from "../src/integrations/api/capabilities.ts";
import type { Card } from "../src/integrations/types.ts";
import { BusLive, CacheLive, ChangesLive, SettingsLive, extensionStoreLayer } from "../src/integrations/services.ts";
import { repoStatusOf, runCard, statusOne } from "../src/integrations/effects.ts";
import githubExtension, { githubSummaryContributor, prLooseEnds } from "../src/extensions/github/index.ts";
import azureDevopsExtension, { azureDevopsSummaryContributor } from "../src/extensions/azure-devops/index.ts";
import { Shell } from "@corvi/shell";
import { Workspace as WorkspaceTag } from "@corvi/contracts/workspace";
import { workspaceById } from "../src/workspace/server/index.ts";
import type { Result } from "../src/capabilities/shell.ts";
import { fakeShell, runEffect, runWithShell, TestError, type FakeShell } from "./helpers.ts";

/**
 * The cards' server half: the GitHub tree and the Azure DevOps tree the dashboard draws, the
 * azure-devops routes its page fetches, and the orchestration that runs a contributed effect.
 * Everything here is driven through the fake Shell (test/helpers.ts) or through in-memory
 * Card/extension stubs, so no `az`, `gh` or `git` process is ever started.
 */

beforeEach(() => {
  clearCache();
});

const change = (over: Partial<Change> = {}): Change => ({
  id: "PROJ-1",
  branch: "PROJ-1-thing",
  repos: [],
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
  answer: (line: string, cwd: string | undefined) => string | Partial<Result> | undefined,
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

  const items = await runWithShell(shell, github.repoStatus!(change({ repos: [orderRepo] }), orderRepo));
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
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 10, name: "build-example-api", path: "\\example-api" }]);
    }
    // Pipelines run on the pull request's merge ref once a PR exists.
    if (line.includes("--branch refs/pull/5/merge")) return JSON.stringify([run]);
    if (line.includes("--branch refs/heads/")) return "[]";
    return undefined;
  });

  const items = await runWithShell(shell, azure.repoStatus!(change({ repos: [orderRepo] }), orderRepo));
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
    if (line.startsWith("az pipelines list ")) {
      return JSON.stringify([{ id: 10, name: "build-example-api", path: "\\example-api" }]);
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

  const items = await runWithShell(shell, azure.repoStatus!(change({ repos: [orderRepo] }), orderRepo));
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
    if (line.startsWith("az pipelines list ")) return "[]";
    return undefined;
  });

  // A repository built by GitHub Actions, or by pipelines in another project, has nothing here
  // to show: the GitHub card carries the checks, and this card stays silent.
  const items = await runWithShell(shell, azure.repoStatus!(change({ repos: [orderRepo] }), orderRepo));
  expect(items).toEqual([]);
});

test("a repository with no worktree reads as no worktree, not as a failed lookup", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    // No worktree line at all: the change has never touched this repository.
    if (line === "git worktree list --porcelain") return "";
    return undefined;
  });

  const items = await runWithShell(shell, github.repoStatus!(change({ repos: [orderRepo] }), orderRepo));
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

  const items = await runWithShell(shell, github.repoStatus!(change({ repos: [orderRepo] }), orderRepo));
  const prRow = items[0]!.children![0]!;
  expect(prRow).toMatchObject({ label: "no pull request", detail: "not pushed yet", state: "none" });
  expect(prRow.actions).toEqual([{ id: "create", label: "Push & create PR", arg: orderRepo }]);
});

test("the github create action pushes and opens the pull request", async () => {
  const shell = fakeShell((cmd) => {
    const line = cmd.join(" ");
    return checkedOut(line) ?? undefined;
  });

  await runWithShell(shell, github.run!(change({ repos: [orderRepo] }), "create", orderRepo));
  const lines = shell.calls.map((c) => c.cmd.join(" "));
  expect(lines).toContain(`git push -u origin ${branch}`);
  expect(lines).toContain("gh pr create --fill");
});

test("the github card refuses an action it does not know, and create without a repository", async () => {
  const shell = fakeShell();
  await expect(
    runWithShell(shell, github.run!(change({ repos: [orderRepo] }), "bogus", orderRepo)),
  ).rejects.toThrow("unknown github action: bogus");
  await expect(runWithShell(shell, github.run!(change({ repos: [orderRepo] }), "create", undefined))).rejects.toThrow(
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
    if (line.startsWith("az pipelines list ")) {
      return active ? JSON.stringify([{ id: 10, name: "build-example-api", path: "\\example-api" }]) : "[]";
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
    githubSummaryContributor.facts(change({ repos: [orderRepo] })),
  );
  expect(summary.facts).toEqual([
    { id: "unresolved", label: "1 unresolved comment", state: "warn" },
  ]);
  expect(summary.state).toBe("ok");
});

test("the azure-devops summary counts active pipelines, in the singular and plural", async () => {
  const { clearCache } = await import("../src/capabilities/cache.ts");
  const one = await runWithShell(
    summaryShell(1, 0),
    azureDevopsSummaryContributor.facts(change({ repos: [orderRepo] })),
  );
  expect(one.facts).toEqual([{ id: "pipelines", label: "1 pipeline active", state: "pending" }]);
  // A pipeline in flight is pending whatever the last checks said.
  expect(one.state).toBe("pending");

  // The `az devops configure` answer and the branch answers are shared per workspace: a
  // second summary in the same process asks again rather than reading the first one's.
  clearCache();
  const two = await runWithShell(
    summaryShell(2, 0),
    azureDevopsSummaryContributor.facts(change({ repos: [orderRepo] })),
  );
  expect(two.facts.map((f) => f.label)).toEqual(["2 pipelines active"]);
});

test("an idle inbox and idle pipelines contribute nothing but the idle line", async () => {
  const githubSummary = await runWithShell(
    summaryShell(0, 0),
    githubSummaryContributor.facts(change({ repos: [orderRepo] })),
  );
  expect(githubSummary.facts).toEqual([]);
  expect(githubSummary.state).toBe("ok");

  const azureSummary = await runWithShell(
    summaryShell(0, 0),
    azureDevopsSummaryContributor.facts(change({ repos: [orderRepo] })),
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
    azureDevopsSummaryContributor.facts(change({ repos: [orderRepo] })),
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
    prLooseEnds(change({ repos: [orderRepo, brokenRepo, goneRepo] })),
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
    ChangesLive,
    Layer.succeed(WorkspaceTag, workspaceById(workspaceId)),
    extensionStoreLayer("test"),
  );

const runRoute = <A, E>(
  shell: FakeShell,
  effect: Effect.Effect<A, E, Capabilities>,
  workspaceId?: string,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(Effect.provide(effect, extLayer(shell, workspaceId))));

/** The config is one refilled object every module holds: swap the workspaces for the body of a
 * test, and put them back so no other test inherits them. */
const withWorkspaces = async <A>(workspaces: Workspace[], work: () => Promise<A>): Promise<A> => {
  const before = runtimeConfig().workspaces;
  runtimeConfig().workspaces = workspaces;
  try {
    return await work();
  } finally {
    runtimeConfig().workspaces = before;
  }
};

const jsonOf = async <A>(result: Either.Either<Response, A>): Promise<unknown> => {
  if (Either.isLeft(result)) throw result.left;
  return result.right.json();
};

test("the services route answers for a workspace that enabled azure-devops", async () => {
  const shell = fakeShell();
  const workspace: Workspace = {
    id: "acme",
    name: "Acme",
    extensionSettings: {
      "azure-devops": { organization: "https://dev.azure.com/acme", project: "acme-proj" },
    },
  };
  const result = await withWorkspaces([workspace], () =>
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
  const result = await withWorkspaces(
    [
      { id: "first", name: "First" },
      { id: "second", name: "Second" },
    ],
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
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("BadRequestError");
    expect(result.left.message.length).toBeGreaterThan(0);
  }
});

test("the deploy route refuses a body missing the version or the environment, or not an object at all", async () => {
  const call = (body: unknown): Promise<Either.Either<Response, unknown>> =>
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
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Error);
      expect((result.left as Error).message).toBe("version and environment required");
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
  const call = (body: unknown): Promise<Either.Either<Response, unknown>> =>
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
  expect(Either.isLeft(known)).toBe(true);
  if (Either.isLeft(known)) expect((known.left as Error).message).toBe("no deploy pipeline for example-api");

  const unknown = await call({ version: "v1", environment: "staging" });
  expect(Either.isLeft(unknown)).toBe(true);
  if (Either.isLeft(unknown)) expect((unknown.left as Error).message).toBe("unknown environment: staging");
});

// --- effects: provisioning, status/repoStatus, actions and the read-only finished change ----

/** A card whose effects are pure, so the orchestration in effects.ts is what is under test. */
const card = (over: Partial<Card> = {}): Card => ({ title: "Card", ...over });

const widget = (over: Partial<Widget> = {}): Widget => ({
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
  const rows: WidgetItem[] = [{ label: "worktree", actions: [{ id: "a", label: "A" }] }];
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
