import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** File-based config, read once at startup. Environment variables still win, so tests and
 * one-off runs need no file. */
type Config = {
  /** Where per-change directories (worktrees, change.json) are created. */
  changesRoot: string;
  /** Base directory the repository browser starts from. */
  reposRoot: string;
  /** Directory the browser opens on, inside reposRoot. Going up to reposRoot stays possible;
   * this only saves the clicks you make every single time. */
  reposStart: string;
  /** Who a change's Jira issue is assigned to on creation. Empty means "the logged-in user". */
  jiraAssignee: string;
  /** Transition a change's Jira issue moves to on creation. */
  jiraStartTransition: string;
  /** Transition a change's Jira issue moves to when the change is completed. */
  jiraDoneTransition: string;
  /** Azure DevOps organisation and project; empty means "whatever az devops configure holds". */
  azureOrganization: string;
  azureProject: string;
};

export const configPath = (): string =>
  process.env.IWE_CONFIG ?? join(homedir(), ".config", "iwe", "config.json");

export const expandTilde = (path: string): string =>
  path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

const defaults: Pick<Config, "changesRoot" | "reposRoot"> = {
  changesRoot: join(homedir(), "changes"),
  reposRoot: join(homedir(), "Repos"),
};

const file: Partial<Config> = (() => {
  try {
    // Sync on purpose: config is needed before the first request and never changes at runtime.
    const text = require("node:fs").readFileSync(configPath(), "utf8") as string;
    return JSON.parse(text) as Partial<Config>;
  } catch {
    return {};
  }
})();

const resolve = (value: string | undefined, fallback: string): string => {
  const path = expandTilde(value ?? fallback);
  if (!isAbsolute(path)) throw new Error(`config path must be absolute: ${path}`);
  return path;
};

export const config: Config = {
  changesRoot: resolve(process.env.IWE_ROOT ?? file.changesRoot, defaults.changesRoot),
  reposRoot: resolve(process.env.IWE_REPOS_ROOT ?? file.reposRoot, defaults.reposRoot),
  reposStart: resolve(
    process.env.IWE_REPOS_START ?? file.reposStart,
    process.env.IWE_REPOS_ROOT ?? file.reposRoot ?? defaults.reposRoot,
  ),
  jiraAssignee: process.env.IWE_JIRA_ASSIGNEE ?? file.jiraAssignee ?? "",
  jiraStartTransition:
    process.env.IWE_JIRA_START_TRANSITION ?? file.jiraStartTransition ?? "In Progress",
  jiraDoneTransition: process.env.IWE_JIRA_DONE_TRANSITION ?? file.jiraDoneTransition ?? "Done",
  azureOrganization: process.env.IWE_AZURE_ORG ?? file.azureOrganization ?? "",
  azureProject: process.env.IWE_AZURE_PROJECT ?? file.azureProject ?? "",
};
