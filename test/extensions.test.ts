import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeDir, createChange, readChange, writeChange } from "../src/change/server/index.ts";
import { runEffect, TestError } from "./helpers.ts";
import { Effect } from "effect";
import {
  changeTabsFor,
  dispatchExtensionRoute,
  extensionsFor,
  install,
  loaded,
  pagesFor,
  windowPresenters,
  wizardStepsFor,
} from "../src/core/host/index.ts";
import type {
  Extension,
  TerminalPresenter,
  WindowPresentation,
} from "../src/core/host/api.ts";
import { presentWindow } from "../src/terminal/server/index.ts";
import { looseEnds } from "../src/change/server/index.ts";
import { repoFromRemote } from "../src/extensions/github-issues/index.ts";
import { refOf, refLabel } from "../src/extensions/github-issues/shared.ts";
import { ticketOf } from "../src/extensions/jira/jira.ts";
import { config, type Workspace } from "../src/workspace/server/index.ts";
import type { Change } from "../src/core/domain/change.ts";

/**
 * A changes root of its own, because creating a change writes one.
 */
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-extensions-"));
  process.env.IWE_ROOT = tmp;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "test", name: "Test", ...patch });

/** A window as tmux reports it, raw: the facts before anyone says what to call it. */
const raw = (over: Partial<Parameters<typeof presentWindow>[0]> = {}): { index: number; name: string; command: string; active: boolean; activity: boolean; directory: string; named: boolean; options: Record<string, string>; id: string; } => ({
  index: 3,
  id: "@3",
  name: "zsh",
  command: "node",
  active: true,
  activity: false,
  directory: "example-api",
  named: false,
  options: {},
  ...over,
});

/** A presenter that says the same thing about every window running node, and nothing about
 * any other window — so the core defaults have their say on those. */
const constant = (
  answer: WindowPresentation | undefined,
  paneOptions?: string[],
): TerminalPresenter => ({
  paneOptions,
  present: (w) => (w.command === "node" ? answer : undefined),
});

test("a window's presentation: the first presenter to answer a field wins, the core defaults last", () => {
  const first = install({
    name: "test-presenters-first",
    title: "First",
    windowPresenters: [
      // The first presenter in the list answers running and icon; it leaves state alone.
      constant({ running: "first running", icon: "first" }),
      constant({ icon: "second-in-first", state: "ok" }),
    ],
  });
  const second = install({
    name: "test-presenters-second",
    title: "Second",
    windowPresenters: [constant({ detail: "second detail", running: "too late" })],
  });
  try {
    const w = presentWindow(raw());
    // The first presenter's running wins, and the label composes around it.
    expect(w.label).toBe("example-api - (first running)");
    // First presenter wins per field; the field it left out falls through to the next.
    expect(w.icon).toBe("first");
    expect(w.state).toBe("ok");
    // Across extensions, load order: the second extension's detail lands where nobody earlier
    // answered, and its running loses to the first's.
    expect(w.detail).toBe("second detail");
    // Where nobody answered at all, the core's defaults speak.
    expect(presentWindow(raw({ command: "zsh" }))).toMatchObject({
      label: "example-api",
      detail: "zsh (zsh) in example-api",
      icon: "terminal",
      state: "idle",
    });
    // The pane options the loaded presenters declare are the ones tmux is asked for.
    const agent = install({
      name: "test-presenters-agent",
      title: "Agent",
      windowPresenters: [constant(undefined, ["@agent_status"])],
    });
    try {
      expect(windowPresenters().flatMap((p) => p.paneOptions ?? [])).toContain("@agent_status");
    } finally {
      loaded.splice(loaded.indexOf(agent), 1);
    }
  } finally {
    loaded.splice(loaded.indexOf(first), 1);
    loaded.splice(loaded.indexOf(second), 1);
  }
});

test("extension routes match :param patterns, first pattern wins", async () => {
  const ext = install({
    name: "test-routes",
    title: "Routes",
    routes: [
      {
        method: "GET",
        path: "/services/:service/versions",
        handler: (_req, params) => Effect.succeed(Response.json({ route: "versions", service: params.service })),
      },
      {
        method: "GET",
        path: "/services/:service",
        handler: (_req, params) => Effect.succeed(Response.json({ route: "service", service: params.service })),
      },
      {
        method: "POST",
        path: "/services/:service/deploy",
        handler: (_req, params) => Effect.succeed(Response.json({ route: "deploy", service: params.service })),
      },
    ],
  });
  try {
    const call = (path: string, method = "GET"): Promise<unknown> | undefined =>
      dispatchExtensionRoute(new Request(`http://localhost/api/ext/test-routes/${path}`, { method }))
        ?.then((r) => r.json());
    // Registration order: the more specific pattern is declared first and wins.
    expect(await call("services/web/versions")).toEqual({ route: "versions", service: "web" });
    expect(await call("services/web")).toEqual({ route: "service", service: "web" });
    // The method is part of the pattern.
    expect(await call("services/web/deploy")).toBeUndefined();
    expect(await call("services/web/deploy", "POST")).toEqual({ route: "deploy", service: "web" });
    // No pattern of that shape: undefined, which the server turns into its 404.
    expect(await call("other")).toBeUndefined();
    expect(await call("services/web/versions/extra")).toBeUndefined();
  } finally {
    loaded.splice(loaded.indexOf(ext), 1);
  }
});

test("extension route params are percent-decoded", async () => {
  const ext = install({
    name: "test-routes-decode",
    title: "Routes decode",
    routes: [
      {
        method: "GET",
        path: "/services/:service/versions",
        handler: (_req, params) => Effect.succeed(Response.json({ service: params.service })),
      },
    ],
  });
  try {
    const call = (path: string): Promise<unknown> | undefined =>
      dispatchExtensionRoute(new Request(`http://localhost/api/ext/test-routes-decode/${path}`))
        ?.then((r) => r.json());
    // The client encodes (encodeURIComponent), and a captured segment arrives decoded, as the
    // handlers see it elsewhere.
    expect(await call("services/a%20b/versions")).toEqual({ service: "a b" });
    expect(await call("services/web%2Fapi/versions")).toEqual({ service: "web/api" });
    // A malformed escape falls back to the raw segment rather than throwing.
    expect(await call("services/a%zz/versions")).toEqual({ service: "a%zz" });
  } finally {
    loaded.splice(loaded.indexOf(ext), 1);
  }
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

test("cancelling asks the loose-end contributors, in load order, and a failure contributes nothing", async () => {
  const first = install({
    name: "test-loose-first",
    title: "First",
    looseEnds: [
      { looseEnds: () => Effect.succeed(["the first end"]) },
      // Several contributors on one extension: flattened in declaration order.
      { looseEnds: () => Effect.succeed(["another", "and one more"]) },
    ],
  });
  const second = install({
    name: "test-loose-second",
    title: "Second",
    looseEnds: [
      // A vendor being down is not a reason for a cancellation to fail: the gatherer swallows it.
      { looseEnds: () => Effect.fail(new TestError({ message: "vendor down" })) },
      { looseEnds: () => Effect.succeed(["the second extension's end"]) },
    ],
  });
  try {
    const change: Change = { id: "L", branch: "L", repos: [], createdAt: "" };
    const ends = await Effect.runPromise(looseEnds(change));
    // Extension by extension, contributor by contributor — load order decides, the same order
    // every other per-workspace surface reads in.
    expect(ends).toEqual([
      "the first end",
      "another",
      "and one more",
      "the second extension's end",
    ]);
  } finally {
    loaded.splice(loaded.indexOf(first), 1);
    loaded.splice(loaded.indexOf(second), 1);
  }
});

test("a workspace that names no extensions has them all", () => {
  const enabled = extensionsFor(ws()).map((e) => e.name);
  // The built-ins, whatever they are — and the jira extension among them.
  expect(enabled).toEqual(loaded.map((e) => e.name));
  expect(enabled).toContain("jira");
});

test("a workspace that names its extensions gets exactly those, in registration order", () => {
  const enabled = extensionsFor(ws({ extensions: ["ci", "github-issues"] })).map((e) => e.name);
  expect(enabled).toEqual(["ci", "github-issues"]);
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
  const withBoth = pagesFor(ws({ extensions: ["deployments", "leftovers"] }));
  expect(withBoth.map((p) => [p.extension, p.id])).toEqual([
    ["deployments", "deployments"],
    ["leftovers", "leftovers"],
  ]);
  // A context that dropped leftovers has no Leftovers entry, not an empty one.
  const withoutLeftovers = pagesFor(ws({ extensions: ["deployments"] }));
  expect(withoutLeftovers.map((p) => p.extension)).not.toContain("leftovers");
});

test("a change tab is offered only in a context that has the extension, and a duplicate id is owned by the first", () => {
  const first = install({
    name: "test-tab-first",
    title: "First tab",
    changeTabs: [{ id: "inspect", title: "Inspect" }],
  });
  const second = install({
    name: "test-tab-second",
    title: "Second tab",
    // The same id as the first: a tab id is its identity on the URL, so the first owns it.
    changeTabs: [
      { id: "inspect", title: "Inspect again" },
      { id: "timeline", title: "Timeline" },
    ],
  });
  try {
    const both = changeTabsFor(ws({ extensions: ["test-tab-first", "test-tab-second"] }));
    expect(both).toEqual([
      { id: "inspect", title: "Inspect", extension: "test-tab-first" },
      { id: "timeline", title: "Timeline", extension: "test-tab-second" },
    ]);

    // A context that dropped the first extension gets the second's tab under that id.
    const withoutFirst = changeTabsFor(ws({ extensions: ["test-tab-second"] }));
    expect(withoutFirst).toEqual([
      { id: "inspect", title: "Inspect again", extension: "test-tab-second" },
      { id: "timeline", title: "Timeline", extension: "test-tab-second" },
    ]);

    // A context without either extension has no tab to show, not an empty one.
    expect(changeTabsFor(ws({ extensions: [] }))).toEqual([]);
  } finally {
    loaded.splice(loaded.indexOf(first), 1);
    loaded.splice(loaded.indexOf(second), 1);
  }
});

test("a completion step is planned only when the change has something for it", () => {
  // The jira extension's contributor: planned for a change with a ticket, absent without one,
  // readable from either place the key may live.
  const jira = loaded.find((e) => e.name === "jira")!;
  const contributor = jira.completionSteps[0]!;
  const ctx = { config, workspace: ws() };
  const legacy = { id: "A", branch: "A", repos: [], createdAt: "", jira: "PROJ-1" } as unknown as Change;
  expect(contributor.plan(legacy, ctx)).toEqual({
    id: "jira",
    label: "move PROJ-1 to Done",
    state: "waiting",
  });
  const withBag: Change = { id: "B", branch: "B", repos: [], createdAt: "", extensions: { jira: { key: "PROJ-2" } } };
  expect(contributor.plan(withBag, ctx)?.label).toBe("move PROJ-2 to Done");
  expect(contributor.plan({ id: "C", branch: "C", repos: [], createdAt: "" }, ctx)).toBeUndefined();

  // The github-issues extension's: the label names the issue without a subprocess, so the plan
  // is honest about what is coming before anything runs.
  const gh = loaded.find((e) => e.name === "github-issues")!;
  const ghPlanned = gh.completionSteps[0]!.plan(
    { id: "D", branch: "D", repos: [], createdAt: "", extensions: { "github-issues": { repo: "/r/thing", number: 9 } } },
    ctx,
  );
  expect(ghPlanned?.label).toBe("close thing#9");
  expect(gh.completionSteps[0]!.plan({ id: "E", branch: "E", repos: [], createdAt: "" }, ctx)).toBeUndefined();
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
