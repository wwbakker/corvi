import { isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import type { Config } from "@corvi/configuration/config";
import type { Settings, SettingsView } from "../model.ts";
import { overriddenExtensionSettings, overriddenSettings } from "@corvi/configuration/settings";
import { ENV_OVERRIDES } from "./legacySettings.ts";
import {
  runtimeConfig,
  configPath,
  readFileSync,
  reloadConfig,
  expandTilde,
  updateConfigFile,
  devicesFrom,
  remoteAccessFrom,
  DirectoryName,
  EnvVarName,
  WorkspaceId,
} from "../../workspace/server/index.ts";
import type { ConfigFile } from "../../workspace/server/index.ts";
import { loaded } from "../../integrations/index.ts";
import { migrateExtensionSettings, migrateFileSettings } from "../../integrations/migrate.ts";
import { keepStoredSecrets, redactSecrets } from "./secrets.ts";
import { redactDeviceHashes } from "./deviceSecrets.ts";
import { keepStoredRemoteTokens, redactRemoteTokens } from "./remoteSecrets.ts";
import { BadRequestError } from "@corvi/contracts/errors";
import { RemoteAccess } from "@corvi/contracts/config";
import { invalidate } from "../../capabilities/cache.ts";
import { runtimeReconcileRemoteAccess, runtimeRemoteAccessStatus } from "../../capabilities/runtime.ts";
import { TOOLING } from "../../capabilities/os.ts";

/**
 * Reading and writing the settings file from the page.
 *
 * The file stays the source of truth — it is hand-editable, it is what the manual documents, and
 * a settings page that kept its own copy would be a second one. This only writes it, and then
 * refills the object every module already imported, so a change takes effect on the next request
 * rather than on the next restart.
 *
 * Validation is here rather than in the browser because the file can be edited by hand: bad
 * values must be caught wherever they come from, and a page that duplicated the rules would
 * eventually disagree with them.
 */

export const settingsView = Effect.sync(() => settingsViewSync());

/** The settings page's read: the file as written, what is in effect, what is locked. Sync by
 * contract; the Effect form is settingsView above, which the server uses. */
export const settingsViewSync = (): SettingsView => {
  const file = readFileSync();
  // The file is handed over migrated, so the page edits — and writes back — the shape the
  // extensions read today, never the retired names the migration folds away.
  migrateFileSettings(file);
  // The file view gets the same tolerance the resolved config does: a hand-mangled device entry
  // is dropped rather than spread into a bogus device on the page, and a malformed remote-access
  // value is replaced by the default. A value the file does not have stays absent.
  const viewFile: Settings = {
    ...file,
    ...(file.devices === undefined ? {} : { devices: devicesFrom(file.devices) }),
    ...(file.remoteAccess === undefined ? {} : { remoteAccess: remoteAccessFrom(file.remoteAccess) }),
  };
  return {
    path: configPath(),
    // The page gets a copy with the extensions' secrets and the remote device tokens masked: it
    // is given the file and what is in effect, and neither may carry a credential.
    file: redactRemoteTokens(redactDeviceHashes(redactSecrets(viewFile, loaded))),
    effective: redactRemoteTokens(redactDeviceHashes(redactSecrets(runtimeConfig(), loaded))),
    // Runtime, not file: whether the external listener the file asks for actually bound.
    remoteAccessStatus: runtimeRemoteAccessStatus(),
    overridden: overriddenSettings(ENV_OVERRIDES),
    overriddenExtensions: overriddenExtensionSettings(loaded),
    toolingDefault: TOOLING,
    extensions: loaded.map((e) => ({
      name: e.name,
      title: e.title,
      settings: e.settings,
    })),
  };
};

const absolute = (value: string | undefined): boolean =>
  !value || isAbsolute(expandTilde(value));

/** Everything wrong with these settings, in the order it appears on the page. Empty means they
 * can be written. The rules that are plain shapes (a word-shaped id, a directory name, an
 * environment variable name) are the same Schemas the config layer decodes with — one
 * statement of the rule, used wherever it is checked. The settings themselves are checked by
 * one function at both scopes — the global level and each workspace's `settings` — so the two
 * cannot grow different rules. */
export function problems(next: Settings): string[] {
  const found: string[] = [];

  const scopeProblems = (scope: Settings, where?: string): void => {
    const at = (message: string): void => {
      found.push(where ? `${where}: ${message}` : message);
    };
    for (const field of ["changesRoot", "archiveRoot", "repositoriesDirectory"] as const) {
      if (!absolute(scope[field])) at(`${field} must be an absolute path`);
    }
    for (const key of Object.keys(scope.env ?? {})) {
      if (!Schema.is(EnvVarName)(key)) at(`"${key}" is not an environment variable name`);
    }
    for (const name of scope.worktreeCopy ?? []) {
      if (!name.trim() || !Schema.is(DirectoryName)(name)) {
        at(`"${name}" is not a directory name next to the code`);
      }
    }
    const names = scope.extensions ?? [];
    for (const name of names) {
      if (!loaded.some((e) => e.name === name)) at(`there is no extension called "${name}"`);
    }
    const duplicates = names.filter((name, i, all) => all.indexOf(name) !== i);
    if (duplicates.length) at(`"${duplicates[0]}" is named twice`);
  };

  scopeProblems(next);

  // Remote access is top-level only, and its port must be a real one. An absent value is fine:
  // it means off on the default port.
  if (next.remoteAccess !== undefined && !Schema.is(RemoteAccess)(next.remoteAccess)) {
    found.push("remoteAccess must name a port between 1 and 65535");
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

    // A hand-edited file (or a buggy page) can put anything under `remote`: report it as a
    // validation message rather than reading `.url` off a null and throwing out of the route.
    const remote: unknown = workspace.remote;
    if (remote !== undefined) {
      if (typeof remote !== "object" || remote === null) {
        found.push(`${where}: remote must be an object with a url and a workspace`);
      } else {
        const target = remote as { readonly url?: unknown; readonly workspace?: unknown };
        // A remote workspace's settings live on the server that hosts it: carrying both would be
        // two answers to the same question. Refused, not silently ignored.
        if (workspace.settings !== undefined) {
          found.push(`${where} is remote: it cannot also carry settings`);
        }
        if (typeof target.url !== "string" || !isHttpUrl(target.url)) {
          found.push(`${where}: the remote url must be http or https`);
        }
        if (!Schema.is(WorkspaceId)(target.workspace)) {
          found.push(`${where}: the remote workspace id must be a word`);
        }
      }
    }
    scopeProblems(workspace.settings ?? {}, where);
  }

  return found;
}

/** A remote URL is a real http(s) URL: what the gateway will eventually proxy to. */
const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

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
 * Merged over what the file holds, not replacing it: a key Corvi does not know about was put there
 * by hand, for a version of Corvi that does, and losing it silently would be rude. The ENV_OVERRIDES
 * locking and the empty-field-means-unset pruning still apply, and a masked secret is the stored
 * value rather than the mask (apps/server/src/settings/server/secrets.ts).
 */
export const writeSettings = (
  next: Settings,
): Effect.Effect<SettingsView, BadRequestError> =>
  Effect.gen(function* () {
    const wrong = problems(next);
    if (wrong.length) {
      return yield* new BadRequestError({ message: wrong.join("; ") });
    }

    // The read, merge and write are one serialized mutation: a device revoked between a page's
    // load and its save must not be written back from the stale list the page was handed.
    // Secrets first, before anything is merged: a field the page sent back as a mask keeps what
    // the file holds, and one it left alone stays cleared. The same rule restores a remote
    // workspace's device token.
    yield* updateConfigFile((stored) => {
      const kept = keepStoredRemoteTokens(keepStoredSecrets(next, stored, loaded), stored);
      return prune({
        ...stored,
        ...kept,
        // Devices are managed by the device API, never by a settings-page save: a page that
        // sends the masked device list back leaves what is stored untouched.
        devices: stored.devices,
      }) as ConfigFile;
    });

    yield* reloadConfig;
    // Remote access is a listener, not just a value: a save that toggles it or moves its port
    // brings the external listener in line now, without a restart.
    yield* runtimeReconcileRemoteAccess();
    // The retired names fold into the extensions' own settings, in memory as on disk —
    // a page save is also a migration.
    migrateExtensionSettings(runtimeConfig().workspaces);
    // Everything the CLIs answered was answered for the settings just replaced: another
    // organisation, another Jira site, another set of environments. Cheaper to ask again than to
    // reason about which.
    invalidate("");
    return yield* settingsView;
  });

/** A workspace as the page adds one: everything off by default is wrong — a new context is
 * usually another client, with both. */
export const blankWorkspace = (id: string): Config["workspaces"][number] => ({ id, name: "" });
