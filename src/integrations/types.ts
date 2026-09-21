/**
 * The surface types the included integrations and their consumers share. Capabilities, service
 * tags and the error taxonomy are imported from `src/capabilities/` directly: these modules are
 * ordinary code now, and this file holds only what describes a surface.
 */

import type { Card } from "./api/cards.ts";
import type { Page } from "./api/pages.ts";
import type { ChangeTab } from "./api/tabs.ts";
import type { DashboardWidget } from "./api/widgets.ts";
import type { RequestMethod, RouteHandler } from "./api/routes.ts";
import type { ExtensionSetting, WorkspaceSetting } from "./api/settings.ts";
import type { WizardStep } from "./api/wizard.ts";

export type { Card } from "./api/cards.ts";
export type { WizardStep } from "./api/wizard.ts";
export type {
  TmuxWindow,
  WindowPresentation,
  TerminalPresenter,
} from "./api/terminal.ts";
export type { Page } from "./api/pages.ts";
export type { ChangeTab } from "./api/tabs.ts";
export type { DashboardWidget, WidgetComponent } from "./api/widgets.ts";
export type { ExtensionSetting, WorkspaceSetting } from "./api/settings.ts";
export type { RouteError, RouteHandler, RequestMethod } from "./api/routes.ts";

/**
 * One included integration, as a value: everything it contributes, described as fields rather
 * than registered anywhere. Arrays are orders: the dashboard's card order, the wizard's step
 * order within a phase, the completion steps' run order. `src/integrations/included.ts` fixes
 * the order across integrations.
 */
export type IncludedIntegration = {
  /** The extension's identity: the key of its entry in a change's `extensions` bag, its
   * cards' identity on the routes, the prefix of its routes. Must be unique. */
  name: string;
  title: string;

  /** Per-workspace settings this extension wants: flat string fields, one per workspace, shown
   * on the settings page for every workspace that has this extension enabled and stored where
   * the extension itself reads them back — `workspace.extensionSettings[name][key]`. */
  workspaceSettings?: WorkspaceSetting[];

  cards?: Card[];
  wizardSteps?: WizardStep[];
  /** Pages this extension offers the sidebar. */
  pages?: Page[];
  /** Tabs this extension adds to a change's page, beside the core's Dashboard. The
   * tab's client half exports `tab`, a component receiving the change. */
  changeTabs?: ChangeTab[];
  /** Client-drawn widgets this extension adds to a change's dashboard, beside the
   * server-drawn cards. The widget's client half exports `widget`, a component receiving
   * the change — for content with client state (a textarea's debounce, an unsaved marker)
   * that a server-drawn card's polled rows cannot hold. */
  dashboardWidgets?: DashboardWidget[];
  /** Server-wide settings this extension declares, shown on the settings page for every
   * workspace — a server-wide thing is configured once, not per context. */
  globalSettings?: ExtensionSetting[];
  routes?: { method: RequestMethod; path: string; handler: RouteHandler }[];
};
