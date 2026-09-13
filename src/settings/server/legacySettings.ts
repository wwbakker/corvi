import type { ExtensionSetting } from "../../extension-host/api.ts";

/**
 * The settings precedence chain, in one place.
 *
 * Every setting that has both a flat config field and an extension bag entry follows the same
 * chain: what the settings page wrote under `extensionSettings[name][key]` (the bag) wins; when
 * the bag is empty the flat field answers, and that field itself resolves as environment
 * variable → config file → vendor default. Every reader — the extension reads (the
 * azure-devops extension's own settings read in src/extensions/azure-devops/, through its
 * legacy.ts) and the flat-field reads (src/workspace/server/config.ts's `load()`) — goes
 * through `resolveSetting`.
 *
 * A caller hands `resolveSetting` whichever levels it holds: `load()` holds the file and the
 * environment, while an extension read holds the already-resolved flat value and only adds the
 * bag on top.
 */

/**
 * Which environment variable overrides which setting.
 *
 * The settings page shows these as locked rather than pretending to edit them: an environment
 * variable wins, so writing the file would change nothing and look like a bug. The resolver
 * reads the same map, so a field's override is named once.
 */
export const ENV_OVERRIDES: Record<string, string> = {
  changesRoot: "IWE_ROOT",
  reposRoot: "IWE_REPOS_ROOT",
  reposStart: "IWE_REPOS_START",
  worktreeCopy: "IWE_WORKTREE_COPY",
  extensionPaths: "IWE_EXTENSION_PATHS",
};

/** One extension's settings bag, as the config holds it: a value is one string or a list. */
export type SettingBag = Record<string, string | string[]>;

/** One string field of a bag: a non-string, or an empty one, is not set. */
export const bagString = (bag: SettingBag | undefined, key: string): string | undefined => {
  const value = bag?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

/** One list field of a bag: only a list of non-empty strings counts, and an empty list is not
 * set — empty means unset, which is what clearing every row on the page means. */
export const bagList = (bag: SettingBag | undefined, key: string): string[] | undefined => {
  const value = bag?.[key];
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((v): v is string => typeof v === "string" && Boolean(v.trim()));
  return names.length ? names : undefined;
};

/**
 * Resolve one setting down the chain: the bag first, then the environment variable, then the
 * flat field as the file holds it, then the vendor default. A bag value of `undefined` is not
 * set — empty means unset.
 *
 * `parse` turns a raw environment value into the setting's shape; returning `undefined` from it
 * keeps the environment from counting, which is how a field says "an empty override is no
 * override" where that is its convention (IWE_EXTENSION_PATHS, IWE_AZURE_ENVIRONMENTS). With no
 * `parse`, the raw string is the value, which is what a plain string setting wants.
 */
export function resolveSetting<T>(spec: {
  bag?: T;
  env?: string;
  file?: T;
  fallback: T;
  parse?: (raw: string) => T | undefined;
}): T {
  if (spec.bag !== undefined) return spec.bag;
  const raw = spec.env === undefined ? undefined : process.env[spec.env];
  if (raw !== undefined) {
    const parsed = spec.parse ? spec.parse(raw) : (raw as unknown as T);
    if (parsed !== undefined) return parsed;
  }
  return spec.file ?? spec.fallback;
}

/** The environment variable currently overriding this setting, or undefined. The settings page
 * renders a set one as locked instead of pretending the page can edit it. */
export const envOverride = (variable: string | undefined): string | undefined =>
  variable !== undefined && process.env[variable] !== undefined ? variable : undefined;

/** The flat settings the settings page shows locked, by field: only the variables that are
 * actually set — an override nobody has made is not one. */
export function overriddenSettings(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [field, variable] of Object.entries(ENV_OVERRIDES)) {
    const override = envOverride(variable);
    if (override) found[field] = override;
  }
  return found;
}

/** The same, for the fields the extensions declare: a setting whose `env` names a variable
 * that is set is shown locked, with the variable named. */
export function overriddenExtensionSettings(
  extensions: readonly { name: string; globalSettings: readonly ExtensionSetting[] }[],
): Record<string, Record<string, string>> {
  const found: Record<string, Record<string, string>> = {};
  for (const extension of extensions) {
    for (const field of extension.globalSettings) {
      const override = envOverride(field.env);
      if (override) (found[extension.name] ??= {})[field.key] = override;
    }
  }
  return found;
}
