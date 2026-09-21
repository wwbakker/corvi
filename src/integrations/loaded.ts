import type { IncludedIntegration } from "../integrations/types.ts";
import { includedIntegrations } from "../integrations/included.ts";
import type {
  Card,
  ChangeTab,
  DashboardWidget,
  ExtensionSetting,
  Page,
  RequestMethod,
  RouteHandler,
  WizardStep,
  WorkspaceSetting,
} from "../integrations/types.ts";

/**
 * The composed integrations, normalized: what the rest of the server reads.
 *
 * The list is fixed at import time by `src/integrations/included.ts` — ordinary modules, no
 * discovery, no factories, no second installation path.
 */

/** One integration, as loaded: its description, normalized — the arrays coalesced to empty. */
export type LoadedIntegration = {
  name: string;
  title: string;
  cards: Card[];
  wizardSteps: WizardStep[];
  /** The routes, compiled at import: each declared path split on "/", with `:name` segments
   * capturing. Matched in registration order within the integration, composition order across
   * them. */
  routes: CompiledRoute[];
  /** Pages this integration offers the sidebar. */
  pages: Page[];
  /** Tabs this integration adds to a change's page, in declaration order. A tab id is the tab's
   * identity on the route and the URL, so two integrations cannot both own one: across a
   * workspace's integrations the first in composition order keeps the id, and a later one's is
   * skipped (`changeTabsFor` in ./selectors.ts). */
  changeTabs: ChangeTab[];
  /** Client-drawn widgets this integration adds to a change's dashboard, in declaration order.
   * Widgets carry no address — the page keys them by integration plus id — so duplicates
   * coexist. */
  dashboardWidgets: DashboardWidget[];
  /** Per-workspace settings the integration declares, for the settings page to render. */
  workspaceSettings: WorkspaceSetting[];
  /** Server-wide settings the integration declares, for the settings page to render. */
  globalSettings: ExtensionSetting[];
};

/** One route pattern, compiled from its declaration: the declared path split on "/". A segment
 * starting with ":" captures one path segment of the request; the others must match exactly.
 * There is no pattern syntax beyond that — routes that need more read the URL themselves. */
export type CompiledRoute = {
  method: RequestMethod;
  segments: string[];
  handler: RouteHandler;
};

export const compileRoutes = (ext: IncludedIntegration): CompiledRoute[] =>
  (ext.routes ?? []).map((r) => ({
    method: r.method,
    segments: r.path.split("/").filter((segment) => segment !== ""),
    handler: r.handler,
  }));

const normalize = (ext: IncludedIntegration): LoadedIntegration => ({
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
});

/** Everything included, in composition order — which is the dashboard's card order and the
 * wizard's step order within a phase. */
export const loaded: LoadedIntegration[] = includedIntegrations.map(normalize);
