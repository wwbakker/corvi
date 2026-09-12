import type { Change } from "../../domain/change.ts";
import { config } from "./config.ts";
import type { Workspace } from "../../domain/config.ts";

/**
 * Which context a change belongs to, and what that context implies.
 *
 * A workspace is not only a filter: a personal project has no Jira issue and no Azure pipeline,
 * and asking about either is both noise on the page and most of what a refresh costs on a change
 * that has neither. This is where "which client's world is this" turns into settings.
 */
export const workspaces = (): Workspace[] => config.workspaces;

/** The workspace with this id, or the first one — where every change without one belongs. */
export function workspaceById(id?: string): Workspace {
  return workspaces().find((w) => w.id === id) ?? workspaces()[0]!;
}

export const workspaceOf = (change: Change): Workspace => workspaceById(change.workspace);

/** Whether an extension exists in this workspace. Absent means all of them: a workspace that
 * names no extensions has every one. This is the one enablement rule, shared by every surface
 * that asks; a vendor's own client adds its legacy flag on top (src/vendors/azure.ts's
 * `azureEnabled`/`azureConfigured`). */
export const extensionEnabled = (workspace: Workspace, name: string): boolean =>
  workspace.extensions ? workspace.extensions.includes(name) : true;

/** Where the repository browser opens for this workspace. */
export const reposStartOf = (workspace: Workspace): string =>
  workspace.reposStart || config.reposStart;
