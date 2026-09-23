import { runtimeConfig } from "../../capabilities/runtime.ts";
import type { WorkspaceDto as Workspace } from "@corvi/contracts/config";
import type { EffectiveSettings } from "@corvi/configuration/config";
import {
  extensionEnabled as enabled,
  extensionsFor,
  workspaceById as byId,
  workspaceOf as of,
} from "@corvi/configuration/workspaces";
import { settingsFor } from "@corvi/configuration/settings";
import { ENV_OVERRIDES } from "../../settings/server/legacySettings.ts";

/**
 * Which context a change belongs to, and what that context implies — the app's `runtimeConfig()`
 * bound to `@corvi/configuration/workspaces`' pure selection and `@corvi/configuration/settings`'
 * precedence chain.
 *
 * A workspace is not only a filter: a personal project has no Jira issue and no Azure pipeline,
 * and asking about either is both noise on the page and most of what a refresh costs on a change
 * that has neither. This is where "which client's world is this" turns into settings.
 */
export const workspaces = (): Workspace[] => runtimeConfig().workspaces;

/** The workspace with this id, or the first one — where every change without one belongs. */
export function workspaceById(id?: string): Workspace {
  return byId(workspaces(), id);
}

/** Which context a change belongs to. The selection reads the change's `workspace` field and
 * nothing else, so that field is all this takes: a caller with a partial change states what is
 * read rather than casting past the fields it does not hold. */
export const workspaceOf = (change: { readonly workspace?: string }): Workspace =>
  of(workspaces(), change);

/** What applies in this workspace: every setting resolved down the chain (environment variable >
 * workspace > global > default), for the app's own reads and any caller that wants one
 * workspace's view of the settings without walking the two levels itself. */
export const settingsOf = (workspace?: Workspace): EffectiveSettings =>
  settingsFor(runtimeConfig(), workspace, ENV_OVERRIDES);

/** Whether an extension exists in this workspace. The one enablement rule, shared by every
 * surface that asks: the workspace's `extensions` list overrides the global one, and no list at
 * all means every extension. */
export const extensionEnabled = (workspace: Workspace, name: string): boolean =>
  enabled(runtimeConfig(), workspace, name);

/** The names this workspace's `extensions` list leaves enabled: its own list, the global one
 * when it names none, and no list at all meaning every extension. */
export const extensionNamesFor = (workspace: Workspace): readonly string[] | undefined =>
  extensionsFor(runtimeConfig(), workspace);

/** Where the repository browser opens for this workspace: its own setting, the global one when
 * it names none. The browser is unbounded, so this is only the starting point. */
export const repositoriesDirectoryOf = (workspace: Workspace): string =>
  settingsOf(workspace).repositoriesDirectory;
