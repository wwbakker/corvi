/**
 * The settings module's public face: the settings file's read/write surface, and the precedence
 * chain both the config loader and the settings page read through.
 *
 * `@corvi/configuration/settings` is a leaf shared with the workspace module's config loader and
 * the top-level deployments settings. Those import the package directly rather than through this
 * barrel, which keeps the module graph acyclic while the chain stays stated once; the env
 * variable names (`ENV_OVERRIDES`) are the app's and stay in `./legacySettings.ts`.
 */
export {
  settingsView,
  settingsViewSync,
  problems,
  writeSettings,
  blankWorkspace,
} from "./settings.ts";

/** The mask a stored secret is replaced by in the view: the page's contract with the server, so
 * the two halves and their tests name it once (`./secrets.ts`). */
export { MASK } from "./secrets.ts";

export type { Settings, SettingsView } from "../model.ts";

export {
  bagString,
  bagList,
  resolveSetting,
  envOverride,
  overriddenSettings,
  overriddenExtensionSettings,
  type SettingBag,
} from "@corvi/configuration/settings";

export { ENV_OVERRIDES } from "./legacySettings.ts";
