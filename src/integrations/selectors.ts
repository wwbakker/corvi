import type { Change } from "../domain/change.ts";
import type { Workspace } from "../domain/config.ts";
import { workspaceOf } from "../workspace/server/index.ts";
import { loaded, type LoadedIntegration } from "./loaded.ts";
import type {
  Card,
  ChangeTab,
  DashboardWidget,
  Page,
  WizardStep,
} from "../integrations/types.ts";

/**
 * The workspace queries: which extensions exist for a workspace, and one flat list per surface
 * they contribute to. Every selector below is the same shape — take the workspace's extensions,
 * concatenate each one's slice — so that shape lives once, in `contributed`, rather than as a
 * clone per surface. The output order is load order, which is
 * also each surface's presentation order.
 */

/**
 * Which extensions exist for this workspace.
 *
 * A workspace that names none has all of them, which is what an unconfigured machine gets.
 * Enablement is the extensions list alone.
 */
export const extensionsFor = (workspace: Workspace): LoadedIntegration[] => {
  const names = workspace.extensions;
  if (!names) return [...loaded];
  const wanted = new Set(names);
  return loaded.filter((e) => wanted.has(e.name));
};

/** One surface across a workspace's extensions, concatenated in load order. */
const contributed = <T>(
  workspace: Workspace,
  pick: (ext: LoadedIntegration) => readonly T[],
): T[] => extensionsFor(workspace).flatMap(pick);

/** The cards a change's dashboard shows, with the extension each belongs to — the extension's
 * name is the card's identity on the routes. */
export const cardsFor = (change: Change): { name: string; card: Card }[] =>
  contributed(workspaceOf(change), (e) => e.cards.map((card) => ({ name: e.name, card })));

/** One card by the extension's name, across every loaded extension. A change's workspace
 * governs which cards are *listed*; a card addressed directly is looked up everywhere. */
export const cardForExtension = (name: string): Card | undefined =>
  loaded.find((e) => e.name === name)?.cards[0];

/** The wizard steps of a workspace, in presentation order: issue steps before the change
 * details, repository-aware steps after the repositories are picked. */
export type WizardStepInfo = WizardStep & { extension: string };

export const wizardStepsFor = (workspace: Workspace): WizardStepInfo[] => {
  const steps = contributed(workspace, (e) =>
    e.wizardSteps.map((s) => ({ ...s, extension: e.name })),
  );
  return [...steps.filter((s) => s.phase === "issue"), ...steps.filter((s) => s.phase === "repos")];
};

/** A client-drawn widget on a change's dashboard, with the extension it belongs to — the
 * extension plus the id is the key the page knows the widget by. */
export type DashboardWidgetInfo = DashboardWidget & { extension: string };

/** The client-drawn widgets a change's dashboard shows, in load order. Widgets carry no
 * address, so there is no first-wins rule and no reserved ids: two extensions may each draw
 * one, and the page tells them apart by extension plus id. */
export const widgetsFor = (change: Change): DashboardWidgetInfo[] =>
  contributed(workspaceOf(change), (e) =>
    e.dashboardWidgets.map((widget) => ({ ...widget, extension: e.name })),
  );

/** The pages a workspace's sidebar offers, with the extension each belongs to — the page's
 * identity on the routes and the URL is the extension's own. */
export type PageInfo = Page & { extension: string };

export const pagesFor = (workspace: Workspace): PageInfo[] =>
  contributed(workspace, (e) => e.pages.map((page) => ({ ...page, extension: e.name })));

/** A change tab across a workspace's extensions, with the extension each belongs to — the
 * tab's identity on the routes and the change URL. */
export type ChangeTabInfo = ChangeTab & { extension: string };

/** The core's own change-page ids. A contributed tab may not shadow one: the core addressed it
 * first, and dropping it here keeps the route and the page's selector in agreement for any
 * client. */
const CORE_TAB_IDS: ReadonlySet<string> = new Set(["dashboard", "terminals"]);

/** Drop the tabs the core owns the address for and later duplicates of one id; the first
 * declaration wins. Pure, so the rule is testable without an integration to inject. */
export const visibleChangeTabs = (tabs: readonly ChangeTabInfo[]): ChangeTabInfo[] => {
  const seen = new Set<string>();
  const visible: ChangeTabInfo[] = [];
  for (const tab of tabs) {
    if (CORE_TAB_IDS.has(tab.id) || seen.has(tab.id)) continue;
    seen.add(tab.id);
    visible.push(tab);
  }
  return visible;
};

/** The tabs a workspace's integrations add to a change's page, in composition order. A tab id
 * is the tab's identity on the route and the URL, so a duplicate would be two tabs at one
 * address: the first integration to declare an id keeps it and a later one's is skipped. The
 * core's own ids are reserved and never offered. */
export const changeTabsFor = (workspace: Workspace): ChangeTabInfo[] =>
  visibleChangeTabs(
    contributed(workspace, (e) =>
      e.changeTabs.map((t) => ({ ...t, extension: e.name })),
    ),
  );
