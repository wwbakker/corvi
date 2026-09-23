/**
 * The surface types the included integrations and their consumers share. The declarations are
 * the contract's (`@corvi/contracts/integration`); this barrel is the app's one import while
 * the features live under `src`.
 */

export type { Card } from "./api/cards.ts";
export type { WizardStep } from "./api/wizard.ts";
export type {
  TmuxWindow,
  WindowPresentation,
  TerminalPresenter,
} from "@corvi/contracts/terminal";
export type { Page } from "./api/pages.ts";
export type { ChangeTab } from "./api/tabs.ts";
export type { DashboardWidget } from "./api/widgets.ts";
export type { ExtensionSetting } from "./api/settings.ts";
export type { RouteError, RouteHandler, RequestMethod } from "./api/routes.ts";
export type { IncludedIntegration } from "@corvi/contracts/integration";
