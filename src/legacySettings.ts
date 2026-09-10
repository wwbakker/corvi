import type { Workspace } from "./config.ts";
import type { ExtensionSetting } from "./extensions/api.ts";

/**
 * The legacy settings precedence chain, in one place.
 *
 * Every setting an extension gained after the flat config had it follows the same chain: what
 * the settings page wrote under `extensionSettings[name][key]` (the bag) wins; when the bag is
 * empty the legacy flat field answers, and that field itself resolves as environment variable →
 * config file → vendor default. Four modules used to state part of this chain — the extension
 * reads (src/deploySettings.ts, src/workspaces.ts's `azureOf`), the flat-field reads
 * (src/config.ts's `load()`) and the one-time workspace migration — so retiring one legacy field
 * meant touching all of them. They now all go through `resolveSetting`, and the migration lives
 * here too.
 *
 * A caller hands `resolveSetting` whichever levels it holds: `load()` holds the file and the
 * environment, while an extension read holds the already-resolved legacy value and only adds the
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
  jiraAssignee: "IWE_JIRA_ASSIGNEE",
  jiraStartTransition: "IWE_JIRA_START_TRANSITION",
  jiraDoneTransition: "IWE_JIRA_DONE_TRANSITION",
  azureOrganization: "IWE_AZURE_ORG",
  azureProject: "IWE_AZURE_PROJECT",
  worktreeCopy: "IWE_WORKTREE_COPY",
  extensionPaths: "IWE_EXTENSION_PATHS",
  "azureDeploy.environments": "IWE_AZURE_ENVIRONMENTS",
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
 * legacy field as the file holds it, then the vendor default. A bag value of `undefined` is not
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

/**
 * Normalize the workspaces' extension settings against what is loaded, in place.
 *
 * Two legacy shapes are folded into the one key extensions read today:
 *
 * - a workspace still configuring Jira through its own `jira` object has those fields copied
 *   into `extensionSettings.jira`, where the jira extension's declaration puts and reads them;
 * - a workspace still switching a piece of the world off with the vendor's own flag —
 *   `jira: false`, `azure: false` — and naming no extensions gets an explicit list: everything
 *   loaded except what the flags exclude (`jira`, `deployments`). Naming some is the whole
 *   list, and a list you can read is worth more than flags nothing reads anymore. The flags
 *   meant what they always meant — this context has no pipelines — and enablement now honours
 *   it; the deployments implementation keeps its own guard too (src/deployments.ts's
 *   `usesAzure`), belt and braces, no behaviour change.
 *
 * A workspace with an explicit `extensions` list is otherwise never touched. Everything else is
 * left exactly as it was. Run after the built-ins load and after every settings write
 * (src/settings.ts), so both hand-edits and page writes land normalized.
 *
 * The loaded names are a parameter rather than an import: the registry owns them, and this
 * module must not reach back into `extensions/index.ts` — `config.ts` imports it, and the
 * registry's startup awaits would then run while the config object is still being built.
 */
export function migrateWorkspaceSettings(
  workspaces: Workspace[],
  allExtensionNames: readonly string[],
): Workspace[] {
  for (const workspace of workspaces) {
    if (workspace.jira && !workspace.extensionSettings?.jira) {
      const { project, board, configFile, tokenEnv } = workspace.jira;
      workspace.extensionSettings = {
        ...workspace.extensionSettings,
        jira: {
          ...(project !== undefined && { project }),
          ...(board !== undefined && { board }),
          ...(configFile !== undefined && { configFile }),
          ...(tokenEnv !== undefined && { tokenEnv }),
        },
      };
    }
    // The vendor flags, folded into the list they were always standing in for. A workspace
    // that names some is left alone: naming some is the whole list.
    if (!workspace.extensions) {
      const excluded = [
        ...(workspace.jira === false ? ["jira"] : []),
        ...(workspace.azure === false ? ["deployments"] : []),
      ];
      if (excluded.length > 0) {
        workspace.extensions = allExtensionNames.filter((name) => !excluded.includes(name));
      }
    }
  }
  return workspaces;
}
