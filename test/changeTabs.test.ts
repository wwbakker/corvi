import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Effect } from "effect";
import { Changes } from "../src/extension-host/api.ts";
import { capabilitiesLayer } from "../src/extension-host/services.ts";
import { extensionHostRoutes } from "../src/extension-host/routes.ts";
import { changeDir, createChange } from "../src/change/server/index.ts";
import { provisionRepo } from "../src/vendors/git.ts";
import { install, loaded } from "../src/extension-host/index.ts";
import { config, workspaceById } from "../src/workspace/server/index.ts";
import { runEffect, runSh } from "./helpers.ts";

/**
 * E2's new surface and capability, with no consumer yet: the change-tab route and the read-only
 * `Changes` layer. Both are exercised through the real thing — the guarded route handler and
 * `capabilitiesLayer` — rather than through a thin wrapper beside them.
 */

let tmp: string;
let repo: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-change-tabs-"));
  process.env.IWE_ROOT = join(tmp, "changes");
  repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await Bun.write(join(repo, "README.md"), "hi\n");
  await runSh(["git", "add", "."], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], repo);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The route as server.ts mounts it, called with the path parameter Bun would have filled in. */
const tabsOf = async (id: string): Promise<{ id: string; title: string; extension: string }[]> => {
  const route = extensionHostRoutes["/api/changes/:id/tabs"] as unknown as {
    GET: (req: Request, srv: unknown) => Promise<Response>;
  };
  const req = Object.assign(new Request(`http://127.0.0.1:4000/api/changes/${id}/tabs`), {
    params: { id },
  });
  const response = await route.GET(req, undefined);
  expect(response.status).toBe(200);
  return ((await response.json()) as { tabs: { id: string; title: string; extension: string }[] }).tabs;
};

/** The widgets route, the same way: what the dashboard renders is what the server lists. */
const widgetsOf = async (
  id: string,
): Promise<{ id: string; title: string; extension: string; column?: "left" | "right" }[]> => {
  const route = extensionHostRoutes["/api/changes/:id/widgets"] as unknown as {
    GET: (req: Request, srv: unknown) => Promise<Response>;
  };
  const req = Object.assign(new Request(`http://127.0.0.1:4000/api/changes/${id}/widgets`), {
    params: { id },
  });
  const response = await route.GET(req, undefined);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      widgets: { id: string; title: string; extension: string; column?: "left" | "right" }[];
    }
  ).widgets;
};

test("the tabs route lists an extension's tab for the workspace that has it, and hides it otherwise", async () => {
  const ext = install({
    name: "test-change-tab",
    title: "Test change tab",
    changeTabs: [{ id: "inspect", title: "Inspect" }],
  });
  const saved = config.workspaces;
  config.workspaces = [
    { id: "with-tab", name: "With tab", extensions: ["test-change-tab"] },
    { id: "without-tab", name: "Without tab", extensions: [] },
  ];
  try {
    const enabled = await runEffect(
      createChange({ id: "PROJ-TAB-ON", repos: [repo], workspace: "with-tab" }),
    );
    const disabled = await runEffect(
      createChange({ id: "PROJ-TAB-OFF", repos: [repo], workspace: "without-tab" }),
    );

    expect(await tabsOf(enabled.id)).toEqual([
      { id: "inspect", title: "Inspect", extension: "test-change-tab" },
    ]);
    // A workspace that dropped the extension has no tab for it, not an empty one.
    expect(await tabsOf(disabled.id)).toEqual([]);
  } finally {
    config.workspaces = saved;
    loaded.splice(loaded.indexOf(ext), 1);
  }
});

test("the widgets route lists an extension's widget for the workspace that has it, and hides it otherwise", async () => {
  const ext = install({
    name: "test-dashboard-widget",
    title: "Test dashboard widget",
    dashboardWidgets: [{ id: "notes", title: "Notes" }],
  });
  const saved = config.workspaces;
  config.workspaces = [
    { id: "with-widget", name: "With widget", extensions: ["test-dashboard-widget"] },
    { id: "without-widget", name: "Without widget", extensions: [] },
  ];
  try {
    const enabled = await runEffect(
      createChange({ id: "PROJ-WIDGET-ON", repos: [repo], workspace: "with-widget" }),
    );
    const disabled = await runEffect(
      createChange({ id: "PROJ-WIDGET-OFF", repos: [repo], workspace: "without-widget" }),
    );

    expect(await widgetsOf(enabled.id)).toEqual([
      { id: "notes", title: "Notes", extension: "test-dashboard-widget" },
    ]);
    // A workspace that dropped the extension has no widget for it, not an empty one.
    expect(await widgetsOf(disabled.id)).toEqual([]);
  } finally {
    config.workspaces = saved;
    loaded.splice(loaded.indexOf(ext), 1);
  }
});

test("a duplicate tab id is owned by the first extension, at the route as in the selector", async () => {
  const first = install({
    name: "test-tab-a",
    title: "A",
    changeTabs: [{ id: "inspect", title: "A inspect" }],
  });
  const second = install({
    name: "test-tab-b",
    title: "B",
    changeTabs: [{ id: "inspect", title: "B inspect" }],
  });
  const saved = config.workspaces;
  config.workspaces = [{ id: "dupes", name: "Dupes", extensions: ["test-tab-a", "test-tab-b"] }];
  try {
    const change = await runEffect(
      createChange({ id: "PROJ-TAB-DUP", repos: [repo], workspace: "dupes" }),
    );
    expect(await tabsOf(change.id)).toEqual([
      { id: "inspect", title: "A inspect", extension: "test-tab-a" },
    ]);
  } finally {
    config.workspaces = saved;
    loaded.splice(loaded.indexOf(first), 1);
    loaded.splice(loaded.indexOf(second), 1);
  }
});

test("the tabs route never offers a tab whose id shadows a core page", async () => {
  const ext = install({
    name: "test-tab-shadow",
    title: "Shadow",
    changeTabs: [
      { id: "dashboard", title: "Shadow dashboard" },
      { id: "terminals", title: "Shadow terminals" },
      { id: "inspect", title: "Inspect" },
    ],
  });
  const saved = config.workspaces;
  config.workspaces = [{ id: "shadow", name: "Shadow", extensions: ["test-tab-shadow"] }];
  try {
    const change = await runEffect(
      createChange({ id: "PROJ-TAB-SHADOW", repos: [repo], workspace: "shadow" }),
    );
    // The core addressed dashboard and terminals first, so the route and the client selector
    // drop the shadows rather than let a contributed tab own a core URL.
    expect(await tabsOf(change.id)).toEqual([
      { id: "inspect", title: "Inspect", extension: "test-tab-shadow" },
    ]);
  } finally {
    config.workspaces = saved;
    loaded.splice(loaded.indexOf(ext), 1);
  }
});

/** Run a `Changes`-requiring effect through the real layer, not a hand-built one. */
const runChanges = <A, E>(effect: Effect.Effect<A, E, Changes>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspaceById(undefined))));

test("the Changes layer answers the base branch through the contract", async () => {
  const change = await runEffect(createChange({ id: "PROJ-LAYER-BASE", repos: [repo] }));
  const base = (c: typeof change): Promise<string | undefined> =>
    runChanges(Effect.flatMap(Changes, (changes) => changes.base(c, repo)));

  // No base chosen and no remote on this repository: there is nowhere to start from.
  expect(await base(change)).toBeUndefined();
  // What the change chose answers without asking git, so a stacked change keeps its base.
  expect(await base({ ...change, base: { [repo]: "origin/release" } })).toBe("origin/release");
});

test("the Changes layer reads a change, or answers null when there is none", async () => {
  const created = await runEffect(createChange({ id: "PROJ-LAYER-READ", repos: [repo] }));
  const read = (id: string): Promise<unknown> =>
    runChanges(Effect.flatMap(Changes, (changes) => changes.read(id)));

  expect(await read(created.id)).toEqual(created);
  expect(await read("PROJ-LAYER-NOPE")).toBeNull();
});

test("the Changes layer finds a change's checkout, and answers undefined where it is not set up", async () => {
  const change = await runEffect(createChange({ id: "PROJ-LAYER-WT", repos: [repo] }));
  const checkout = (): Promise<string | undefined> =>
    runChanges(Effect.flatMap(Changes, (changes) => changes.checkout(change, repo)));

  // Nothing has provisioned this change yet: no worktree, so no checkout.
  expect(await checkout()).toBeUndefined();

  await Effect.runPromise(
    Effect.forEach(change.repos, (r) => provisionRepo(change, r), { concurrency: 1 }),
  );
  const found = await checkout();
  // realpath on both sides: macOS temp dirs are symlinks into /private.
  expect(await realpath(found!)).toBe(await realpath(join(changeDir(change.id), basename(repo))));
});
