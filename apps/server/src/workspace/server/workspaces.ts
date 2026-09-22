import type { Change } from "../../domain/change.ts";
import { runtimeConfig } from "../../capabilities/runtime.ts";
import type { WorkspaceDto as Workspace } from "@corvi/contracts/config";
import {
  extensionEnabled as enabled,
  workspaceById as byId,
  workspaceOf as of,
} from "@corvi/configuration/workspaces";

/**
 * Which context a change belongs to, and what that context implies — the app's `runtimeConfig()`
 * bound to `@corvi/configuration/workspaces`' pure selection.
 *
 * A workspace is not only a filter: a personal project has no Jira issue and no Azure pipeline,
 * and asking about either is both noise on the page and most of what a refresh costs on a
 * change that has neither. This is where "which client's world is this" turns into settings.
 */
export const workspaces = (): Workspace[] => runtimeConfig().workspaces;

/** The workspace with this id, or the first one — where every change without one belongs. */
export function workspaceById(id?: string): Workspace {
  return byId(workspaces(), id);
}

export const workspaceOf = (change: Change): Workspace => of(workspaces(), change);

/** Whether an extension exists in this workspace. Absent means all of them: a workspace that
 * names no extensions has every one. This is the one enablement rule, shared by every surface
 * that asks. */
export const extensionEnabled = (workspace: Workspace, name: string): boolean =>
  enabled(workspace, name);

/** Where the repository browser opens for this workspace: its own setting, the global one when it
 * names none. The browser is unbounded, so this is only the starting point. */
export const repositoriesDirectoryOf = (workspace: Workspace): string =>
  workspace.repositoriesDirectory || runtimeConfig().repositoriesDirectory;
