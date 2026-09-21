import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Effect } from "effect";
import { Changes } from "../src/integrations/api/capabilities.ts";
import { capabilitiesLayer } from "../src/integrations/services.ts";
import { integrationRoutes } from "../src/integrations/routes.ts";
import { changeDir, createChange } from "../src/change/server/index.ts";
import { provisionRepo } from "../src/vendors/git.ts";
import { visibleChangeTabs } from "../src/integrations/selectors.ts";
import { runtimeConfig, workspaceById } from "../src/workspace/server/index.ts";
import { runEffect, runSh } from "./helpers.ts";

/**
 * E2's new surface and capability, with no consumer yet: the change-tab route and the read-only
 * `Changes` layer. Both are exercised through the real thing — the guarded route handler and
 * `capabilitiesLayer` — rather than through a thin wrapper beside them.
 */

let tmp: string;
let repo: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-change-tabs-"));
  process.env.CORVI_ROOT = join(tmp, "changes");
  process.env.CORVI_ARCHIVE_ROOT = join(tmp, "changes-archive");
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
  const route = integrationRoutes["/api/changes/:id/tabs"] as unknown as {
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
  const route = integrationRoutes["/api/changes/:id/widgets"] as unknown as {
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

test("the tabs route lists the included tab for the workspace that has it, and hides it otherwise", async () => {
  const saved = runtimeConfig().workspaces;
  runtimeConfig().workspaces = [
    { id: "with-tab", name: "With tab", extensions: ["review"] },
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
      { id: "review", title: "Review changes", extension: "review" },
    ]);
    // A workspace that dropped review has no tab for it, not an empty one.
    expect(await tabsOf(disabled.id)).toEqual([]);
  } finally {
    runtimeConfig().workspaces = saved;
  }
});

test("the widgets route lists the included widget for the workspace that has it, and hides it otherwise", async () => {
  const saved = runtimeConfig().workspaces;
  runtimeConfig().workspaces = [
    { id: "with-widget", name: "With widget", extensions: ["notes"] },
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
      { id: "notes", title: "Notes", extension: "notes", column: "left" },
    ]);
    // A workspace that dropped notes has no widget for it, not an empty one.
    expect(await widgetsOf(disabled.id)).toEqual([]);
  } finally {
    runtimeConfig().workspaces = saved;
  }
});

test("a duplicate tab id is owned by the first integration, at the route as in the selector", () => {
  expect(
    visibleChangeTabs([
      { id: "inspect", title: "A inspect", extension: "a" },
      { id: "inspect", title: "B inspect", extension: "b" },
    ]),
  ).toEqual([{ id: "inspect", title: "A inspect", extension: "a" }]);
});

test("the tabs rule never offers a tab whose id shadows a core page", () => {
  expect(
    visibleChangeTabs([
      { id: "dashboard", title: "Shadow dashboard", extension: "a" },
      { id: "terminals", title: "Shadow terminals", extension: "a" },
      { id: "inspect", title: "Inspect", extension: "a" },
    ]),
  ).toEqual([{ id: "inspect", title: "Inspect", extension: "a" }]);
});

/** Run a `Changes`-requiring effect through the real layer, not a hand-built one. */
const runChanges = <A, E>(effect: Effect.Effect<A, E, Changes>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, capabilitiesLayer(workspaceById(undefined))));

test("the Changes layer answers the base branch through the contract", async () => {
  const change = await runEffect(createChange({ id: "PROJ-LAYER-BASE", repos: [repo] }));
  const base = (c: typeof change): Promise<string | undefined> =>
    runChanges(Effect.flatMap(Changes, (changes) => changes.base(c, repo)));

  // No base chosen and no remote on this repository: its own default branch is what is left.
  expect(await base(change)).toBe("main");
  // What the change chose answers without asking git, so a stacked change keeps its base.
  expect(await base({ ...change, base: { [repo]: "origin/release" } })).toBe("origin/release");
});

test("the Changes layer reads a change, or answers null when there is none", async () => {
  const created = await runEffect(createChange({ id: "PROJ-LAYER-READ", repos: [repo] }));
  const read = (id: string): Promise<unknown> =>
    runChanges(Effect.flatMap(Changes, (changes) => changes.read(id)));

  expect(await read(created.id)).toEqual({ ...created, revision: 1 });
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
