import { expect, test } from "bun:test";
import { includedIntegrations } from "../apps/server/src/integrations/included.ts";
import { changeNav } from "../apps/web/src/change-page/client/changeTabs.ts";
import { viewOf, type View } from "../apps/web/src/app-root/navigation.ts";
import { SURFACES, changeRoute, fileNameOf, isLoadingPlaceholder } from "../scripts/screen-catalog.ts";

/**
 * The catalog's cheap half: no browser, no server, no fixture.
 *
 * What it pins is that the list is well formed and that it reaches every view the app offers —
 * a name per image, a readiness selector per entry, one view per route, and a change view for
 * each of the core's tabs. What it cannot see is what the server offers at runtime (a page an
 * extension adds); `scripts/screens.ts` asks the server it started and fails on a route that has
 * no entry.
 */

/** The pages the included integrations declare, as `viewOf` needs them: the two the catalog's
 * routes name, taken from the integrations themselves rather than restated here. */
const PAGES = includedIntegrations.flatMap((integration) =>
  (integration.pages ?? []).map((page) => ({ id: page.id, extension: integration.name })),
);

/** A view as a comparable key: the name plus what identifies it. */
const keyOf = (view: View): string => JSON.stringify(view);

/** The app's top-level views, from the `View` union in `apps/web/src/app-root/navigation.ts`,
 * with the route each one is reached by. `/api/pages` lists extension pages only, so a core view
 * added to that union is invisible to the runtime coverage check; this list is where it is seen.
 */
const TOP_LEVEL_VIEWS: ReadonlyArray<{ readonly view: View["name"]; readonly route: string }> = [
  { view: "home", route: "/" },
  { view: "new", route: "/new" },
  { view: "actions", route: "/actions" },
  { view: "harnesses", route: "/harnesses" },
  { view: "subagents", route: "/subagents" },
  { view: "settings", route: "/settings" },
];

/** The change views that need a real instance rather than the fixture: the terminal's panes come
 * from a shell, and a finished change's transcripts from an archived change. The live walk
 * (`scripts/shot.ts`) is where they are captured. */
const LIVE_ONLY_CHANGE_VIEWS: ReadonlySet<string> = new Set(["terminals", "transcripts"]);

test("every surface has a unique, kebab-case name", () => {
  const names = SURFACES.map((surface) => surface.name);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("every surface has a readiness selector and a path", () => {
  for (const surface of SURFACES) {
    expect(surface.ready.trim()).not.toBe("");
    expect(surface.route.startsWith("/")).toBe(true);
    expect(surface.route).not.toContain("//");
  }
});

test("every route resolves to one view, and distinct routes to distinct views", () => {
  const byRoute = new Map<string, string>();
  for (const surface of SURFACES) {
    const view = keyOf(viewOf(surface.route, PAGES));
    const seen = byRoute.get(surface.route);
    if (seen === undefined) byRoute.set(surface.route, view);
    else expect(view).toBe(seen);
  }
  const views = [...byRoute.values()];
  expect(new Set(views).size).toBe(views.length);
  // The catalog never falls back to the home view by accident: an extension page it names must
  // resolve to that page, not to `/`.
  const extensionPages = SURFACES.filter((surface) => viewOf(surface.route, PAGES).name === "ext-page");
  expect(extensionPages.length).toBe(
    PAGES.filter((page) => page.id === "leftovers" || page.id === "azure-devops").length,
  );
});

test("every core change view has a surface", () => {
  const routes = new Set(SURFACES.map((surface) => surface.route));
  const core = changeNav([], { finished: false })
    .map((tab) => tab.id)
    .filter((id) => !LIVE_ONLY_CHANGE_VIEWS.has(id));
  expect(core.length).toBeGreaterThan(0);
  for (const id of core) expect(routes.has(changeRoute(id))).toBe(true);
});

test("every top-level view has a surface", () => {
  const routes = new Set(SURFACES.map((surface) => surface.route));
  for (const { view, route } of TOP_LEVEL_VIEWS) {
    expect(viewOf(route, PAGES).name).toBe(view);
    expect(routes.has(route)).toBe(true);
  }
  // And the catalog's top-level routes are exactly those views: one captured without being named
  // above, or named without being captured, fails here.
  const captured = [...routes].filter((route) => {
    const view = viewOf(route, PAGES).name;
    return view !== "change" && view !== "ext-page";
  });
  expect(captured.sort()).toEqual(TOP_LEVEL_VIEWS.map(({ route }) => route).sort());
});

test("the live-only surfaces are the two a fixture cannot show", () => {
  const live = SURFACES.filter((surface) => surface.live === true);
  // The terminal needs a real shell; the Appearance section is the settings tree's own state.
  expect(live.map((surface) => surface.name).sort()).toEqual(["change-terminal", "settings-appearance"]);
  // Each puts the page in a state, which is what a live walk has and a fixture would have to
  // recreate.
  for (const surface of live) expect(surface.setup).toBeDefined();
});

test("the images keep catalog order", () => {
  const names = SURFACES.map((surface, index) => fileNameOf(index, surface));
  expect(names[0]).toBe(`01-${SURFACES[0]!.name}.png`);
  expect(new Set(names).size).toBe(names.length);
  for (const [index, name] of names.entries()) {
    expect(name.startsWith(String(index + 1).padStart(2, "0") + "-")).toBe(true);
    expect(name.endsWith(".png")).toBe(true);
  }
});

test("a placeholder is the app's own text, not any text saying loading", () => {
  // The forms the app draws while data is on the way.
  expect(isLoadingPlaceholder("loading…")).toBe(true);
  expect(isLoadingPlaceholder("  0/2 repositories loaded…  ")).toBe(true);
  expect(isLoadingPlaceholder("3/12 repositories loaded…")).toBe(true);
  // The overview card's facts row before its own read answers: one ellipsis, nothing else.
  expect(isLoadingPlaceholder("…")).toBe(true);
  // Real content in the same elements: a pull request titled like a placeholder, a hint whose word
  // merely begins with "loading", a summary that has finished loading.
  expect(isLoadingPlaceholder("Fix loading spinner")).toBe(false);
  expect(isLoadingPlaceholder("unloading…")).toBe(false);
  expect(isLoadingPlaceholder("loading")).toBe(false);
  expect(isLoadingPlaceholder("12/12 repositories loaded")).toBe(false);
  expect(isLoadingPlaceholder("#128 Add the loading state")).toBe(false);
});
