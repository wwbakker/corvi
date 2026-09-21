/**
 * The settings precedence chain, in one place.
 *
 * Every setting that has both a flat config field and an extension bag entry follows the same
 * chain: what the settings page wrote under `extensionSettings[name][key]` (the bag) wins; when
 * the bag is empty the flat field answers, and that field itself resolves as environment
 * variable → config file → vendor default. Every reader — the extension reads (the azure-devops
 * extension's own settings read in apps/server/src/extensions/azure-devops/, through its legacy.ts) and the
 * flat-field reads (`readConfig` in the app's workspace server) — goes through `resolveSetting`.
 *
 * A caller hands `resolveSetting` whichever levels it holds: the config loader holds the file
 * and the environment, while an extension read holds the already-resolved flat value and only
 * adds the bag on top.
 *
 * The environment variable *names* are the app's (`ENV_OVERRIDES`, built from the product's own
 * identity); this module reads whatever name it is handed, so the naming stays with the product
 * and the precedence stays here.
 */

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
 * override" where that is its convention (CORVI_AZURE_ENVIRONMENTS). With no
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
 * actually set — an override nobody has made is not one. The override names come from the app
 * (`ENV_OVERRIDES`), so this stays a pure reader of the map it is handed. */
export function overriddenSettings(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [field, variable] of Object.entries(overrides)) {
    const override = envOverride(variable);
    if (override) found[field] = override;
  }
  return found;
}

/** One declared extension setting, as much of it as the override check reads. */
export type SettingDeclaration = {
  readonly key: string;
  readonly env?: string;
};

/** One settings holder: an integration and the settings fields it declared. The declaration may
 * be absent, the way an integration that declares none has it. */
export type SettingsHolder = {
  readonly name: string;
  readonly globalSettings?: readonly SettingDeclaration[];
};

/** The same, for the fields the extensions declare: a setting whose `env` names a variable
 * that is set is shown locked, with the variable named. */
export function overriddenExtensionSettings(
  extensions: readonly SettingsHolder[],
): Record<string, Record<string, string>> {
  const found: Record<string, Record<string, string>> = {};
  for (const extension of extensions) {
    for (const field of extension.globalSettings ?? []) {
      const override = envOverride(field.env);
      if (override) (found[extension.name] ??= {})[field.key] = override;
    }
  }
  return found;
}
