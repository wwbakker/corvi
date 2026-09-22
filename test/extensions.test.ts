import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeDir, createChange, readChange, writeChange } from "../apps/server/src/change/server/index.ts";
import { runEffect } from "./helpers.ts";
import { Effect } from "effect";
import {
  changeTabsFor,
  extensionsFor,
  loaded,
  pagesFor,
  widgetsFor,
  wizardStepsFor,
} from "../apps/server/src/integrations/index.ts";
import { matchRoute } from "../apps/server/src/integrations/dispatch.ts";
import type { CompiledRoute } from "../apps/server/src/integrations/loaded.ts";
import { planIssueClose, repoFromRemote } from "@corvi/github/issues";
import { planIssueCompletion } from "../apps/server/src/extensions/jira/index.ts";
import { refOf, refLabel } from "@corvi/contracts/integrations/github-issues";
import { ticketOf } from "../apps/server/src/extensions/jira/jira.ts";
import { unknownIntegrationNames } from "../apps/server/src/integrations/included.ts";
import { runtimeConfig, reloadConfigSync, type Workspace } from "../apps/server/src/workspace/server/index.ts";
import type { Change } from "../apps/server/src/domain/change.ts";

/**
 * A changes root of its own, because creating a change writes one.
 */
let tmp: string;
const originalConfig = process.env.CORVI_CONFIG;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-extensions-"));
  process.env.CORVI_ROOT = tmp;
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "archive");
  // A config of its own: the changes root is not the only environment that leaks in. A
  // developer's own config — a workspace that names its extensions, say — would decide what
  // `extensionsFor` and the enablement rule see, and this file is about the included ones.
  process.env.CORVI_CONFIG = join(tmp, "runtimeConfig().json");
  reloadConfigSync();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env.CORVI_CONFIG;
  else process.env.CORVI_CONFIG = originalConfig;
  reloadConfigSync();
});

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "test", name: "Test", ...patch });

const route = (method: "GET" | "POST", path: string): CompiledRoute => ({
  method,
  segments: path.split("/").filter((segment) => segment !== ""),
  handler: () => Effect.succeed(new Response()),
});

test("extension routes match :param patterns, first fit wins", () => {
  const routes = [
    route("GET", "/services/:service/versions"),
    route("GET", "/services/:service"),
    route("POST", "/services/:service/deploy"),
  ];
  const match = (method: "GET" | "POST", path: string): Record<string, string> | undefined => {
    const parts = path.split("/");
    for (const candidate of routes) {
      const params = matchRoute(candidate, method, parts);
      if (params) return params;
    }
    return undefined;
  };
  // Registration order: the more specific pattern is declared first and wins.
  expect(match("GET", "services/web/versions")).toEqual({ service: "web" });
  expect(match("GET", "services/web")).toEqual({ service: "web" });
  // The method is part of the pattern.
  expect(match("GET", "services/web/deploy")).toBeUndefined();
  expect(match("POST", "services/web/deploy")).toEqual({ service: "web" });
  // No pattern of that shape: undefined, which the server turns into its 404.
  expect(match("GET", "other")).toBeUndefined();
  expect(match("GET", "services/web/versions/extra")).toBeUndefined();
});

test("extension route params are percent-decoded", () => {
  const candidate = route("GET", "/services/:service/versions");
  const match = (part: string): Record<string, string> | undefined =>
    matchRoute(candidate, "GET", ["services", part, "versions"]);
  // The client encodes (encodeURIComponent), and a captured segment arrives decoded, as the
  // handlers see it elsewhere.
  expect(match("a%20b")).toEqual({ service: "a b" });
  expect(match("web%2Fapi")).toEqual({ service: "web/api" });
  // A malformed escape falls back to the raw segment rather than throwing.
  expect(match("a%zz")).toEqual({ service: "a%zz" });
});

test("a remote URL is read in every shape GitHub answers to", () => {
  const parse = (url: string): { owner: string; name: string; } | undefined => repoFromRemote(url);
  expect(parse("https://github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(parse("https://github.com/owner/name")).toEqual({ owner: "owner", name: "name" });
  expect(parse("git@github.com:owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(parse("ssh://git@github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  expect(parse("git://github.com/owner/name.git")).toEqual({ owner: "owner", name: "name" });
  // A trailing newline is what some shells hand back.
  expect(parse("https://github.com/owner/name.git\n")).toEqual({ owner: "owner", name: "name" });
  // Not GitHub, not ours to guess at.
  expect(parse("https://gitlab.com/owner/name.git")).toBeUndefined();
  expect(parse("/some/local/path")).toBeUndefined();
});

test("a change's ticket is read from the bag, and from the legacy field", () => {
  const bag: Change = { id: "A", branch: "A", repos: [], extensions: { jira: { key: "PROJ-2" } }, createdAt: "" };
  const legacy = { id: "B", branch: "B", repos: [], jira: "PROJ-1", createdAt: "" } as unknown as Change;
  const neither: Change = { id: "C", branch: "C", repos: [], createdAt: "" };

  // Both are read: the bag is where the wizard writes, and the legacy field is what archived
  // changes carry; it is no longer part of the Change type, but the decoder keeps it.
  expect(ticketOf(bag)).toBe("PROJ-2");
  expect(ticketOf(legacy)).toBe("PROJ-1");
  expect(ticketOf(neither)).toBeUndefined();
});

test("a change.json with only the legacy jira field reads and keeps it across a rewrite", async () => {
  const id = "PROJ-LEGACY-FILE";
  const dir = changeDir(id);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "change.json"),
    `${JSON.stringify(
      { id, branch: id, repos: [], jira: "PROJ-1", createdAt: "2026-01-01T00:00:00.000Z" },
      null,
      2,
    )}\n`,
  );

  // The decoder preserves the key the core no longer types, so the extension still finds it...
  const read = await runEffect(readChange(id));
  expect(ticketOf(read!)).toBe("PROJ-1");

  // ...and a rewrite serializes what the preserve decode kept: the field is not lost.
  await runEffect(writeChange(read!));
  const again = JSON.parse(await Bun.file(join(dir, "change.json")).text()) as Record<string, unknown>;
  expect(again.jira).toBe("PROJ-1");
});

test("an extension's issue is named by repository and number, and read from the bag", () => {
  const change: Change = {
    id: "A",
    branch: "A",
    repos: [],
    createdAt: "",
    extensions: { "github-issues": { repo: "/repos/thing", number: 7 } },
  };
  const ref = refOf(change);
  expect(ref).toEqual({ repo: "/repos/thing", number: 7 });
  expect(refLabel("owner/thing", ref!)).toBe("owner/thing#7");
  expect(refOf({ id: "B", branch: "B", repos: [], createdAt: "" })).toBeUndefined();
});

test("a workspace's enablement list may only name included integrations", () => {
  expect(unknownIntegrationNames(["jira", "github-issues"])).toEqual([]);
  expect(unknownIntegrationNames(["jira", "memory"])).toEqual(["memory"]);
  // An absent list means all of them, so it names nothing unknown.
  expect(unknownIntegrationNames(undefined)).toEqual([]);
});

test("a workspace that names no extensions has them all", () => {
  const enabled = extensionsFor(ws()).map((e) => e.name);
  // The built-ins, whatever they are — and the jira extension among them.
  expect(enabled).toEqual(loaded.map((e) => e.name));
  expect(enabled).toContain("jira");
});

test("a workspace that names its extensions gets exactly those, in registration order", () => {
  const enabled = extensionsFor(ws({ extensions: ["github", "github-issues"] })).map((e) => e.name);
  expect(enabled).toEqual(["github", "github-issues"]);
  // An empty list means none: an extension cannot sneak back in.
  expect(extensionsFor(ws({ extensions: [] }))).toEqual([]);
  // A name nothing loaded answers for is simply not there.
  expect(extensionsFor(ws({ extensions: ["github-issues", "nonexistent"] })).map((e) => e.name)).toEqual([
    "github-issues",
  ]);
});

test("the wizard's steps follow the phases and the enablement", () => {
  const withJira = wizardStepsFor(ws({ extensions: ["jira", "github-issues"] }));
  // Issue steps first (they prefill the change), repository-aware steps after the repositories.
  expect(withJira.map((s) => [s.extension, s.phase])).toEqual([
    ["jira", "issue"],
    ["github-issues", "repos"],
  ]);
  // A context that dropped jira has no step to show for it, not an empty one.
  const withoutJira = wizardStepsFor(ws({ extensions: ["github-issues"] }));
  expect(withoutJira.map((s) => s.extension)).toEqual(["github-issues"]);
});

test("an extension's page is offered only in a context that has it", () => {
  const withBoth = pagesFor(ws({ extensions: ["azure-devops", "leftovers"] }));
  expect(withBoth.map((p) => [p.extension, p.id])).toEqual([
    ["azure-devops", "azure-devops"],
    ["leftovers", "leftovers"],
  ]);
  // A context that dropped leftovers has no Leftovers entry, not an empty one.
  const withoutLeftovers = pagesFor(ws({ extensions: ["azure-devops"] }));
  expect(withoutLeftovers.map((p) => p.extension)).not.toContain("leftovers");
});

test("a change tab is offered only in a context that has the integration", () => {
  expect(changeTabsFor(ws({ extensions: ["review"] }))).toEqual([
    { id: "review", title: "Review changes", extension: "review" },
  ]);
  // A context that dropped review has no tab for it, not an empty one.
  expect(changeTabsFor(ws({ extensions: ["notes"] }))).toEqual([]);
});

test("dashboard widgets follow the enablement", () => {
  const saved = runtimeConfig().workspaces;
  runtimeConfig().workspaces = [
    { id: "with-notes", name: "Notes", extensions: ["notes"] },
    { id: "no-widgets", name: "None", extensions: [] },
  ];
  try {
    const change: Change = { id: "W", branch: "W", repos: [], createdAt: "" };
    expect(widgetsFor({ ...change, workspace: "with-notes" })).toEqual([
      { id: "notes", title: "Notes", extension: "notes", column: "left" },
    ]);
    // A context without notes has no widget to show, not an empty one.
    expect(widgetsFor({ ...change, workspace: "no-widgets" })).toEqual([]);
  } finally {
    runtimeConfig().workspaces = saved;
  }
});

test("a completion step is planned only when the change has something for it", () => {
  // The jira planner: planned for a change with a ticket, absent without one, readable from
  // either place the key may live.
  const legacy = { id: "A", branch: "A", repos: [], createdAt: "", jira: "PROJ-1" } as unknown as Change;
  expect(planIssueCompletion(legacy, runtimeConfig())).toEqual({
    id: "jira",
    label: "move PROJ-1 to Done",
    state: "waiting",
  });
  const withBag: Change = { id: "B", branch: "B", repos: [], createdAt: "", extensions: { jira: { key: "PROJ-2" } } };
  expect(planIssueCompletion(withBag, runtimeConfig())?.label).toBe("move PROJ-2 to Done");
  expect(planIssueCompletion({ id: "C", branch: "C", repos: [], createdAt: "" }, runtimeConfig())).toBeUndefined();

  // The github-issues planner: the label names the issue without a subprocess, so the plan is
  // honest about what is coming before anything runs.
  const ghPlanned = planIssueClose({
    id: "D",
    branch: "D",
    repos: [],
    createdAt: "",
    extensions: { "github-issues": { repo: "/r/thing", number: 9 } },
  });
  expect(ghPlanned?.label).toBe("close thing#9");
  expect(planIssueClose({ id: "E", branch: "E", repos: [], createdAt: "" })).toBeUndefined();
});

test("the wizard's payload lands on the change record, verbatim and per extension", async () => {
  const created = await runEffect(createChange({
    id: "PROJ-BAG",
    repos: ["/tmp/whatever-repo"],
    workspace: "test",
    extensions: {
      jira: { key: "PROJ-5" },
      "github-issues": { repo: "/repos/thing", number: 12 },
    },
  }));
  const read = await Effect.runPromise(readChange("PROJ-BAG"));
  // The core stores what the extensions picked and never looks inside: both survive as written.
  expect(read?.extensions).toEqual({
    jira: { key: "PROJ-5" },
    "github-issues": { repo: "/repos/thing", number: 12 },
  });
  expect(ticketOf(created)).toBe("PROJ-5");
});
