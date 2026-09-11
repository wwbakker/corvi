/**
 * The settings module's public face: the settings file's read/write surface, and the precedence
 * chain both the config loader and the settings page read through.
 *
 * `legacySettings.ts` is a leaf shared with the workspace module's config loader and the
 * top-level deployments settings. Those import the file directly rather than through this
 * barrel, which keeps the module graph acyclic while the chain stays stated once.
 */
export {
  settingsView,
  settingsViewSync,
  problems,
  writeSettings,
  blankWorkspace,
  type Settings,
  type SettingsView,
} from "./settings.ts";

export {
  ENV_OVERRIDES,
  bagString,
  bagList,
  resolveSetting,
  envOverride,
  overriddenSettings,
  overriddenExtensionSettings,
  type SettingBag,
} from "./legacySettings.ts";
