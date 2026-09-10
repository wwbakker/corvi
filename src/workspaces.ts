import type { Change } from "./types.ts";
import { config, type Workspace } from "./config.ts";
import { deploySettings } from "./deploySettings.ts";

/**
 * Which context a change belongs to, and what that context implies.
 *
 * A workspace is not only a filter: a personal project has no Jira issue and no Azure pipeline,
 * and asking about either is both noise on the page and most of what a refresh costs on a change
 * that has neither. This is where "which client's world is this" turns into settings.
 */
export const workspaces = (): Workspace[] => config.workspaces;

/** The workspace with this id, or the first one — which is where every change made before
 * workspaces existed belongs, since that is where all the work was. */
export function workspaceById(id?: string): Workspace {
  return workspaces().find((w) => w.id === id) ?? workspaces()[0]!;
}

export const workspaceOf = (change: Change): Workspace => workspaceById(change.workspace);

/** Whether an integration applies here at all. Absent means yes: a workspace that says nothing
 * about Azure DevOps is one that has it, which is what IWE was before workspaces existed.
 *
 * Jira has no such helper anymore: enablement is the extensions list, and the site settings are
 * the jira extension's own (src/extensions/jira/jira.ts). */
export const usesAzure = (workspace: Workspace): boolean => workspace.azure !== false;

/** Azure DevOps for this workspace, falling back to the single setting IWE had before — now
 * read through the deployments extension's own chain (the settings bag, then the legacy field,
 * src/deploySettings.ts) — and then to whatever `az devops configure` holds. */
export function azureOf(workspace: Workspace): { organization: string; project: string } {
  const own = workspace.azure === false ? undefined : workspace.azure;
  const global = deploySettings();
  return {
    organization: own?.organization ?? global.organization ?? config.azureOrganization,
    project: own?.project ?? global.project ?? config.azureProject,
  };
}

/** Where the repository browser opens for this workspace. */
export const reposStartOf = (workspace: Workspace): string =>
  workspace.reposStart || config.reposStart;
