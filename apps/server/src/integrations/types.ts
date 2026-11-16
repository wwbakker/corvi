/**
 * The surface types the included integrations and their consumers share. The declarations are
 * the contract's (`@corvi/contracts/integration`); this barrel is the app's one import while
 * the features live under `src`.
 */

export type {
  Card,
  ChangeTab,
  DashboardWidget,
  ExtensionSetting,
  IncludedIntegration,
  Page,
  RequestMethod,
  RouteError,
  RouteHandler,
  WizardStep,
} from "@corvi/contracts/integration";
export type { RawWindow, WindowPresentation, TerminalPresenter } from "@corvi/contracts/terminal";
