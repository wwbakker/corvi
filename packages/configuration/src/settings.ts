/**
 * The settings precedence chain, in one place.
 *
 * Every setting resolves down the same chain: what a set environment variable says (the machine
 * talking — it wins at every scope), then the workspace's value, then the global one, then the
 * vendor default. Every reader goes through `resolveSetting` (each integration reads its own
 * bag with it) or through `settingsFor`, which resolves a whole scope — the app's flat-field
 * reads (`readConfig` in the app's workspace server) and every "what applies here" question.
 *
 * A caller hands `resolveSetting` whichever levels it holds: the config loader holds the global
 * file value, while an extension read holds the workspace's bag entry and the global one. The
 * environment variable *names* are the app's (`ENV_OVERRIDES`, built from the product's own
 * identity); this module reads whatever name it is handed, so the naming stays with the product
 * and the precedence stays here.
 *
 * The one exception to the chain is a `secret` setting: its `env` names a fallback rather than
 * an override, so a stored secret beats it (`apps/server/src/settings/server/secrets.ts`).
 */

import type { Config, EffectiveSettings, Workspace } from "./config.ts";

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
 * Resolve one setting down the chain: the environment variable the declaration names, then the
 * workspace's value, then the global one, then the vendor default. A value of `undefined` is not
 * set — empty means unset.
 *
 * `parse` turns a raw environment value into the setting's shape; returning `undefined` from it
 * keeps the environment from counting, which is how a field says "an empty override is no
 * override" where that is its convention (CORVI_AZURE_ENVIRONMENTS). With no
 * `parse`, the raw string is the value, which is what a plain string setting wants.
 */
export function resolveSetting<T>(spec: {
  /** The environment variable that overrides this setting at every scope. */
  env?: string;
  /** The workspace scope's value. */
  workspace?: T;
  /** The global scope's value. */
  global?: T;
  fallback: T;
  parse?: (raw: string) => T | undefined;
}): T {
  const raw = spec.env === undefined ? undefined : process.env[spec.env];
  if (raw !== undefined) {
    const parsed = spec.parse ? spec.parse(raw) : (raw as unknown as T);
    if (parsed !== undefined) return parsed;
  }
  return spec.workspace ?? spec.global ?? spec.fallback;
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
  readonly settings?: readonly SettingDeclaration[];
};

/** An index that can only become this object's own property: `__proto__`, `constructor` and
 * `prototype` are inherited, so writing through one reaches `Object.prototype` instead of the
 * bag. A declaration may name what it likes; it never writes through the prototype. */
const ownIndex = (name: string): boolean =>
  name !== "__proto__" && name !== "constructor" && name !== "prototype";

/** The same, for the fields the extensions declare: a setting whose `env` names a variable
 * that is set is shown locked, with the variable named — at both scopes, where the same
 * declaration renders. */
export function overriddenExtensionSettings(
  extensions: readonly SettingsHolder[],
): Record<string, Record<string, string>> {
  const found: Record<string, Record<string, string>> = {};
  for (const extension of extensions) {
    for (const field of extension.settings ?? []) {
      const override = envOverride(field.env);
      if (override && ownIndex(extension.name) && ownIndex(field.key)) {
        (found[extension.name] ??= {})[field.key] = override;
      }
    }
  }
  return found;
}

/** The record-shaped settings resolve per key: a workspace entry beats the global entry for its
 * key and leaves the others inherited. */
const merged = <T extends Record<string, unknown>>(
  global: T | undefined,
  workspace: T | undefined,
): T => ({ ...global, ...workspace }) as T;

/**
 * What applies in one scope: every setting, resolved down the chain (environment variable >
 * workspace > global > default). The global scope's own answers are the resolved config's top
 * level; this adds a workspace's overrides on top — for the settings page's "what applies here"
 * and for every reader that holds a workspace and wants its view of the settings.
 */
export function settingsFor(
  config: Omit<Config, "workspaces">,
  workspace: Workspace | undefined,
  envOverrides: Readonly<Record<string, string>>,
): EffectiveSettings {
  const own = workspace?.settings;
  const at = <T>(key: string, spec: {
    workspace?: T;
    global?: T;
    fallback: T;
    parse?: (raw: string) => T | undefined;
  }): T => resolveSetting({ ...spec, env: envOverrides[key] });
  return {
    changesRoot: at("changesRoot", {
      workspace: own?.changesRoot,
      global: config.changesRoot,
      fallback: config.changesRoot,
    }),
    archiveRoot: at("archiveRoot", {
      workspace: own?.archiveRoot,
      global: config.archiveRoot,
      fallback: config.archiveRoot,
    }),
    repositoriesDirectory: at("repositoriesDirectory", {
      workspace: own?.repositoriesDirectory,
      global: config.repositoriesDirectory,
      fallback: config.repositoriesDirectory,
    }),
    notificationSound: resolveSetting({
      workspace: own?.notificationSound,
      global: config.notificationSound,
      fallback: config.notificationSound,
    }),
    contextMenu: resolveSetting({
      workspace: own?.contextMenu,
      global: config.contextMenu,
      fallback: config.contextMenu,
    }),
    ideationPrompt: resolveSetting({
      workspace: own?.ideationPrompt,
      global: config.ideationPrompt,
      fallback: config.ideationPrompt,
    }),
    planTemplate: resolveSetting({
      workspace: own?.planTemplate,
      global: config.planTemplate,
      fallback: config.planTemplate,
    }),
    worktreeCopy: at("worktreeCopy", {
      workspace: own?.worktreeCopy,
      global: config.worktreeCopy,
      fallback: config.worktreeCopy,
      parse: (raw) =>
        raw
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean),
    }),
    extensions: own?.extensions ?? config.extensions,
    extensionSettings: mergedBags(config.extensionSettings, own?.extensionSettings),
    env: merged(config.env, own?.env),
  };
}

/** The extension bags merge per extension and per key: a workspace entry beats the global one
 * for its key and leaves the others inherited. */
const mergedBags = (
  global: Record<string, SettingBag> | undefined,
  workspace: Record<string, SettingBag> | undefined,
): Record<string, SettingBag> => {
  const names = new Set([...Object.keys(global ?? {}), ...Object.keys(workspace ?? {})]);
  const bags: Record<string, SettingBag> = {};
  for (const name of names) {
    if (!ownIndex(name)) continue;
    bags[name] = merged(global?.[name], workspace?.[name]);
  }
  return bags;
};
