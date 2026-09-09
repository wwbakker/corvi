import type { Change } from "./types.ts";
import { config, type Workspace } from "./config.ts";

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
 * about Jira is one that has it, which is what IWE was before workspaces existed.
 *
 * `usesJira` is also what the extension host consults while a workspace has not named its
 * extensions: the legacy flag keeps meaning something until Jira's settings move into its
 * extension. */
export const usesJira = (workspace: Workspace): boolean => workspace.jira !== false;
export const usesAzure = (workspace: Workspace): boolean => workspace.azure !== false;

/** Azure DevOps for this workspace, falling back to the single setting IWE had before, and then
 * to whatever `az devops configure` holds. */
export function azureOf(workspace: Workspace): { organization: string; project: string } {
  const own = workspace.azure === false ? undefined : workspace.azure;
  return {
    organization: own?.organization ?? config.azureOrganization,
    project: own?.project ?? config.azureProject,
  };
}

/** Jira for this workspace: which project, and whose config file — a second client is a second
 * site, a second account and a second token, which is `jira init` in another file. */
export function jiraOf(workspace: Workspace): {
  project?: string;
  board?: string;
  configFile?: string;
  tokenEnv?: string;
} {
  const own = workspace.jira === false ? undefined : workspace.jira;
  return {
    project: own?.project,
    board: own?.board,
    configFile: own?.configFile,
    tokenEnv: own?.tokenEnv,
  };
}

/** Where the repository browser opens for this workspace. */
export const reposStartOf = (workspace: Workspace): string =>
  workspace.reposStart || config.reposStart;
