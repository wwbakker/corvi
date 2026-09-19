/**
 * Contribution types consumed by the loader and dispatchers. Handlers declare their service
 * requirements through Effect; pure selectors receive data directly. Replacement with ordinary
 * capability packages and explicit composition is tracked in docs/plans/architecture-refactor.md.
 */

import type { Effect } from "effect";
import type { Card } from "./api/cards.ts";
import type { CompletionStepContributor, ExtensionEvents } from "./api/lifecycle.ts";
import type {
  DescriptionSection,
  LooseEndContributor,
  SummaryContributor,
  TitleSource,
} from "./api/overview.ts";
import type { Page } from "./api/pages.ts";
import type { ChangeTab } from "./api/tabs.ts";
import type { DashboardWidget } from "./api/widgets.ts";
import type { RequestMethod, RouteHandler } from "./api/routes.ts";
import type { ExtensionSetting, WorkspaceSetting } from "./api/settings.ts";
import type { TerminalPresenter } from "./api/terminal.ts";
import type { Startup } from "./api/capabilities.ts";
import type { WizardStep } from "./api/wizard.ts";

export { Shell, Workspace, Cache, Settings, Bus, ExtensionStore, Changes } from "./api/capabilities.ts";
export type {
  Result,
  Capabilities,
  CreatingCapabilities,
  Startup,
  ExtensionStoreShape,
} from "./api/capabilities.ts";
export type { Card } from "./api/cards.ts";
export type { WizardStep } from "./api/wizard.ts";
export type {
  ChangeDraft,
  PlanWorld,
  CompletionStepContributor,
  ChangeBeforeHook,
  ChangeAfterHook,
  ChangeCreatingHook,
  ExtensionEvents,
} from "./api/lifecycle.ts";
export type {
  SummaryFact,
  TitleSource,
  SummaryContribution,
  SummaryContributor,
  LooseEndContributor,
  DescriptionSection,
} from "./api/overview.ts";
export type {
  TmuxWindow,
  WindowPresentation,
  TerminalPresenter,
} from "./api/terminal.ts";
export type { Page } from "./api/pages.ts";
export type { ChangeTab } from "./api/tabs.ts";
export type { DashboardWidget, WidgetComponent } from "./api/widgets.ts";
export type { ExtensionSetting, WorkspaceSetting } from "./api/settings.ts";
export {
  BadRequestError,
  CliError,
  ConflictError,
  DecodeError,
  NotFoundError,
} from "./api/routes.ts";
export type { RouteError, RouteHandler, RequestMethod } from "./api/routes.ts";

/**
 * An extension, as a value: everything it contributes, described rather than registered.
 *
 * Most extensions are static — a plain object literal, no Effect ceremony. One that needs to
 * compute its contributions at startup (check a CLI exists, read a file, decide conditionally)
 * exports a factory returning this shape from an Effect instead; the loader accepts both.
 *
 * Arrays are orders: the dashboard's card order, the wizard's step order within a phase, the
 * completion steps' run order. Across extensions, the loader's own order decides.
 */
export type Extension = {
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
  titleSources?: TitleSource[];
  descriptionSections?: DescriptionSection[];
  completionSteps?: CompletionStepContributor[];
  /** Facts about a change, said on its overview card; the host merges every contributor's
   * answer into the one summary the card renders. */
  summaryContributions?: SummaryContributor[];
  /** What cancelling a change would leave behind; the host asks every contributor. */
  looseEnds?: LooseEndContributor[];
  /** How tmux windows are named and drawn. Presenters are global, not per-workspace: they
   * are pure functions of tmux data, and a window's name cannot depend on whose client
   * happens to be looking. */
  windowPresenters?: TerminalPresenter[];
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
  events?: ExtensionEvents;
  routes?: { method: RequestMethod; path: string; handler: RouteHandler }[];
};

/** Run once at startup, before any request, and produce the description. A failed load is an
 * extension absent, with the error logged — a broken optional plugin does not take the
 * dashboard down. */
export type ExtensionFactory = () => Effect.Effect<Extension, unknown, Startup>;

/** What an extension module default-exports: a static value, or a factory for one. */
export type ExtensionModule = Extension | ExtensionFactory;
