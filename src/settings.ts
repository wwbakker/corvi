import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import {
  config,
  configPath,
  readFile,
  reloadConfigEffect,
  expandTilde,
  type Config,
} from "./config.ts";
import { overriddenExtensionSettings, overriddenSettings } from "./legacySettings.ts";
import { DirectoryName, EnvVarName, WorkspaceId, type ConfigFile } from "./schemas/config.ts";
import { loaded, migrateWorkspaceSettings } from "./extensions/index.ts";
import { BadRequestError } from "./effect/errors.ts";
import { fs } from "./effect/support.ts";
import { invalidate } from "./cache.ts";
import { TOOLING } from "./tooling.ts";
import type { ExtensionSetting, WorkspaceSetting } from "./extensions/api.ts";

/**
 * Reading and writing the settings file from the page.
 *
 * The file stays the source of truth — it is hand-editable, it is what the README documents, and
 * a settings page that kept its own copy would be a second one. This only writes it, and then
 * refills the object every module already imported, so a change takes effect on the next request
 * rather than on the next restart.
 *
 * Validation is here rather than in the browser because the file can be edited by hand: bad
 * values must be caught wherever they come from, and a page that duplicated the rules would
 * eventually disagree with them.
 */

/** What may be written: the config file's own shape. Everything is optional — an absent value
 * means "the default", which is what an empty file has always meant. */
export type Settings = ConfigFile;

export type SettingsView = {
  /** Which file this is, so the page can say where to look when something is edited by hand. */
  path: string;
  /** What the file holds, as written. */
  file: Settings;
  /** What is actually in effect, defaults and environment included. */
  effective: Config;
  /** Setting to the environment variable currently overriding it. Those are shown as locked:
   * the variable wins, so writing the file would change nothing and look like a bug. */
  overridden: Record<string, string>;
  /** The extensions' server-wide settings an environment variable is currently overriding, by
   * extension name and setting key — the same locking as `overridden`, for the fields the
   * extensions declare on the settings page. */
  overriddenExtensions: Record<string, Record<string, string>>;
  /** What `worktreeCopy` is when it is not set, so the page can offer it back. */
  toolingDefault: string[];
  /** The extensions there are to enable, in the order they were loaded, each with the
   * per-workspace settings it declares — so the page needs no second request to render them. */
  extensions: {
    name: string;
    title: string;
    workspaceSettings: WorkspaceSetting[];
    globalSettings: ExtensionSetting[];
  }[];
};

export const settingsViewEffect = Effect.sync(() => settingsView());

/** The settings page's read: the file as written, what is in effect, what is locked. Sync by
 * contract; the Effect form is settingsViewEffect above, which the server uses. Kept for the
 * test suite, which must pass unmodified.
 *
 * The file is handed over migrated (migrateWorkspaceSettings), so the page edits — and writes
 * back — the shape the extensions read today, never the legacy `jira` key the page no longer
 * renders. */
export const settingsView = (): SettingsView => {
  const file = readFile();
  if (file.workspaces) migrateWorkspaceSettings(file.workspaces);
  return {
    path: configPath(),
    file,
    effective: config,
    overridden: overriddenSettings(),
    overriddenExtensions: overriddenExtensionSettings(loaded),
    toolingDefault: TOOLING,
    extensions: loaded.map((e) => ({
      name: e.name,
      title: e.title,
      workspaceSettings: e.workspaceSettings,
      globalSettings: e.globalSettings,
    })),
  };
};

const absolute = (value: string | undefined): boolean =>
  !value || isAbsolute(expandTilde(value));

/** Everything wrong with these settings, in the order it appears on the page. Empty means they
 * can be written. The rules that are plain shapes (a word-shaped id, a directory name, an
 * environment variable name) are the same Schemas the config layer decodes with — one
 * statement of the rule, used wherever it is checked. */
export function problems(next: Settings): string[] {
  const found: string[] = [];

  for (const field of ["changesRoot", "reposRoot", "reposStart"] as const) {
    if (!absolute(next[field])) found.push(`${field} must be an absolute path`);
  }

  const seen = new Set<string>();
  for (const workspace of next.workspaces ?? []) {
    const where = workspace.name || workspace.id || "a workspace";
    if (!workspace.id?.trim()) found.push(`${where} has no id`);
    else if (!Schema.is(WorkspaceId)(workspace.id)) {
      found.push(`workspace id "${workspace.id}" must be a word`);
    } else if (seen.has(workspace.id)) {
      found.push(`two workspaces share the id "${workspace.id}"`);
    } else seen.add(workspace.id);
    if (!workspace.name?.trim()) found.push(`workspace "${workspace.id}" has no name`);
    if (!absolute(workspace.reposStart)) {
      found.push(`${where}: repositories start must be an absolute path`);
    }
    for (const key of Object.keys(workspace.env ?? {})) {
      if (!Schema.is(EnvVarName)(key)) {
        found.push(`${where}: "${key}" is not an environment variable name`);
      }
    }
    for (const name of workspace.extensions ?? []) {
      if (!loaded.some((e) => e.name === name)) {
        found.push(`${where}: there is no extension called "${name}"`);
      }
    }
    const duplicates = (workspace.extensions ?? []).filter(
      (name, i, all) => all.indexOf(name) !== i,
    );
    if (duplicates.length) {
      found.push(`${where}: "${duplicates[0]}" is named twice`);
    }
  }

  for (const name of next.worktreeCopy ?? []) {
    if (!name.trim() || !Schema.is(DirectoryName)(name)) {
      found.push(`"${name}" is not a directory name next to the code`);
    }
  }

  const deploy = next.azureDeploy;
  if (deploy) {
    if (deploy.pipeline && deploy.pipeline.filter(Boolean).length !== 2) {
      found.push("the pipeline naming needs both a build prefix and a deploy prefix");
    }
    if (deploy.environments && deploy.environments.some((e) => !e.trim())) {
      found.push("an environment has no name");
    }
  }

  return found;
}

/** Values nobody set are left out, so the file stays a page of decisions rather than a dump of
 * every default. An empty string is "not set": that is what clearing a field on the page means. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const kept = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, prune(v)] as const)
      .filter(([, v]) => v !== undefined && v !== "");
    return kept.length ? Object.fromEntries(kept) : undefined;
  }
  return value;
}

/**
 * Write the settings and put them into effect.
 *
 * Merged over what the file holds, not replacing it: a key IWE does not know about was put there
 * by hand, for a version of IWE that does, and losing it silently would be rude. The ENV_OVERRIDES
 * locking and the empty-field-means-unset pruning are unchanged.
 */
export const writeSettingsEffect = (
  next: Settings,
): Effect.Effect<SettingsView, BadRequestError> =>
  Effect.gen(function* () {
    const wrong = problems(next);
    if (wrong.length) {
      yield* Effect.fail(new BadRequestError({ message: wrong.join("; ") }));
    }

    const merged = prune({ ...readFile(), ...next }) as Settings;
    yield* fs(() => mkdir(dirname(configPath()), { recursive: true }));
    yield* fs(() => writeFile(configPath(), `${JSON.stringify(merged, null, 2)}\n`));

    yield* reloadConfigEffect;
    // The legacy `jira` shapes fold into the extension's own settings, in memory as on disk —
    // a page save is also a migration.
    migrateWorkspaceSettings(config.workspaces);
    // Everything the CLIs answered was answered for the old settings: another organisation, another
    // Jira site, another set of environments. Cheaper to ask again than to reason about which.
    invalidate("");
    return yield* settingsViewEffect;
  });

/** A workspace as the page adds one: everything off by default is wrong — a new context is
 * usually another client, with both. */
export const blankWorkspace = (id: string): Config["workspaces"][number] => ({ id, name: "" });
