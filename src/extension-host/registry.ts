import type {
  Card,
  ChangeTab,
  DashboardWidget,
  Extension,
  ExtensionSetting,
  Page,
  RequestMethod,
  RouteHandler,
  WizardStep,
  WorkspaceSetting,
} from "./api.ts";

/**
 * The registry: what has been loaded, in load order, and the two operations that put it there —
 * a static description installed as-is, a factory installed once it has run.
 *
 * This is a leaf module. It imports types and nothing that runs, so the terminal pipelines that
 * read the loaded extensions sit below the host and import neither it nor anything that starts
 * it.
 */

/** One extension, as loaded: its description, normalized — the arrays coalesced to empty. */
export type LoadedExtension = {
  name: string;
  title: string;
  cards: Card[];
  wizardSteps: WizardStep[];
  /** The routes, compiled at install: each declared path split on "/", with `:name` segments
   * capturing. Matched in registration order within the extension, load order across them. */
  routes: CompiledRoute[];
  /** Pages this extension offers the sidebar. */
  pages: Page[];
  /** Tabs this extension adds to a change's page, in declaration order. A tab id is the tab's
   * identity on the route and the URL, so two extensions cannot both own one: across a
   * workspace's extensions the first in load order keeps the id, and a later one's is skipped
   * (`changeTabsFor` in ./selectors.ts), mirroring how a duplicate extension name is resolved
   * by `install`. */
  changeTabs: ChangeTab[];
  /** Client-drawn widgets this extension adds to a change's dashboard, in declaration order.
   * Widgets carry no address — the page keys them by extension plus id — so duplicates coexist. */
  dashboardWidgets: DashboardWidget[];
  /** Per-workspace settings the extension declares, for the settings page to render. */
  workspaceSettings: WorkspaceSetting[];
  /** Server-wide settings the extension declares, for the settings page to render. */
  globalSettings: ExtensionSetting[];
  /** Host-internal, out-of-tree extensions only: the sibling client.tsx of the discovered
   * module, which the server builds into a chunk the page imports at runtime
   * (/extensions/<name>/client.js — src/extension-host/clientChunks.ts). Built-ins are bundled
   * into the page instead and never carry one. */
  clientPath?: string;
};

/** One route pattern, compiled from its declaration at install: the declared path split on
 * "/". A segment starting with ":" captures one path segment of the request; the others must
 * match exactly. There is no pattern syntax beyond that — routes that need more read the URL
 * themselves. */
export type CompiledRoute = {
  method: RequestMethod;
  segments: string[];
  handler: RouteHandler;
};

export const compileRoutes = (ext: Extension): CompiledRoute[] =>
  (ext.routes ?? []).map((r) => ({
    method: r.method,
    segments: r.path.split("/").filter((segment) => segment !== ""),
    handler: r.handler,
  }));

const normalize = (ext: Extension, clientPath?: string): LoadedExtension => ({
  name: ext.name,
  title: ext.title,
  workspaceSettings: ext.workspaceSettings ?? [],
  globalSettings: ext.globalSettings ?? [],
  cards: ext.cards ?? [],
  wizardSteps: ext.wizardSteps ?? [],
  routes: compileRoutes(ext),
  pages: ext.pages ?? [],
  changeTabs: ext.changeTabs ?? [],
  dashboardWidgets: ext.dashboardWidgets ?? [],
  ...(clientPath ? { clientPath } : {}),
});

/** Everything loaded, in load order — which is the dashboard's card order and the wizard's
 * step order within a phase. The test suite prunes and refills this directly. */
export const loaded: LoadedExtension[] = [];

/** Install a static description, rejecting duplicates: a second extension under a used name
 * is skipped with a word, and the original wins. The test suite installs stubs with this. */
export function install(ext: Extension, clientPath?: string): LoadedExtension {
  if (!ext.name) {
    console.error(`an extension without a name is skipped`);
    return normalize({ ...ext, name: "" }, clientPath);
  }
  const clash = loaded.find((e) => e.name === ext.name);
  if (clash) {
    console.error(`two extensions are called "${ext.name}" — the second one is skipped`);
    return clash;
  }
  const record = normalize(ext, clientPath);
  loaded.push(record);
  return record;
}

/** Every loaded extension's window presenters, in load order.
 *
 * Deliberately **global, not per-workspace**: presenters are pure functions of tmux data,
 * they run no effects and take no capabilities, and a window's name cannot depend on whose
 * client happens to be looking. Enablement stays for the surfaces that do things. */
