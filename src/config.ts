import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { TOOLING } from "./tooling.ts";

/**
 * A context you work in: a client, or your own projects. Which changes you are looking at, and —
 * from stage two — where its repositories live and which integrations apply, since a personal
 * project has no Jira issue and no Azure pipeline and should not be asked about either.
 */
export type Workspace = {
  /** Stable, and recorded in a change: renaming the name must not orphan anything. */
  id: string;
  name: string;
  /** Where the repository browser opens in this context. */
  reposStart?: string;
  /** `false` for a context with no Jira at all — a personal project has no ticket, and being
   * asked about one is noise and a CLI call. Otherwise, what differs from the defaults: a
   * second client is a second site, which is `jira init` into another config file. */
  jira?: false | { project?: string; board?: string; configFile?: string; tokenEnv?: string };
  /** `false` for a context with no pipelines: no CI runs are looked for and the deployments page
   * is not offered. */
  azure?: false | { organization?: string; project?: string };
  /**
   * Added to the environment of every CLI run for this workspace. This is how two clients stop
   * fighting over one login: `GH_CONFIG_DIR` for another GitHub account, `AZURE_CONFIG_DIR` for
   * another tenant, `JIRA_API_TOKEN` for another site. `~` is expanded.
   */
  env?: Record<string, string>;
};

/** What a change made before workspaces existed belongs to: the first one, which for everybody
 * who has not configured any is the only one. */
export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "All work" };

/** File-based config, read once at startup. Environment variables still win, so tests and
 * one-off runs need no file. */
export type Config = {
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
  /** The contexts you switch between. One unnamed one when nothing is configured, which is what
   * IWE was before this and behaves the same. */
  workspaces: Workspace[];
  /** IDE and build-tool directories copied from the repository into a new worktree, with the
   * paths inside them rewritten. Empty disables it. See `src/tooling.ts`. */
  worktreeCopy: string[];
  /** How this organisation deploys. None of these names are ours, so all of them are settings:
   * a build pipeline's deploy twin is named by swapping the prefixes, and the deploy pipeline is
   * given the version and the environment as parameters. */
  azureDeploy: {
    /** `["build-", "deploy-"]`: how a build pipeline's name becomes its deploy pipeline's. */
    pipeline: [string, string];
    versionParameter: string;
    environmentParameter: string;
    /** In the order they are deployed to, which is the order they are shown in. */
    environments: string[];
  };
};

export const configPath = (): string =>
  process.env.IWE_CONFIG ?? join(homedir(), ".config", "iwe", "config.json");

export const expandTilde = (path: string): string =>
  path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

const defaults: Pick<Config, "changesRoot" | "reposRoot"> = {
  changesRoot: join(homedir(), "changes"),
  reposRoot: join(homedir(), "Repos"),
};

/** What is in the file, as it is written. Invalid JSON reads as "nothing configured", which is
 * how IWE has always started on a machine that has no config at all. */
export function readFile(): Partial<Config> {
  try {
    // Sync on purpose: config is needed before the first request, and this is one small file.
    const text = require("node:fs").readFileSync(configPath(), "utf8") as string;
    return JSON.parse(text) as Partial<Config>;
  } catch {
    return {};
  }
}

const resolve = (value: string | undefined, fallback: string): string => {
  const path = expandTilde(value ?? fallback);
  if (!isAbsolute(path)) throw new Error(`config path must be absolute: ${path}`);
  return path;
};

/**
 * Which environment variable overrides which setting.
 *
 * The settings page shows these as locked rather than pretending to edit them: an environment
 * variable wins, so writing the file would change nothing and look like a bug.
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
  "azureDeploy.environments": "IWE_AZURE_ENVIRONMENTS",
};

/** The file and the environment, resolved into what the rest of the code reads. */
function load(): Config {
  const file = readFile();
  return {
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
    workspaces: (file.workspaces ?? []).filter((w) => w?.id && w?.name).length
      ? file.workspaces!.filter((w) => w?.id && w?.name)
      : [DEFAULT_WORKSPACE],
    worktreeCopy:
      process.env.IWE_WORKTREE_COPY === undefined
        ? (file.worktreeCopy ?? TOOLING)
        : process.env.IWE_WORKTREE_COPY.split(",")
            .map((n) => n.trim())
            .filter(Boolean),
    azureOrganization: process.env.IWE_AZURE_ORG ?? file.azureOrganization ?? "",
    azureProject: process.env.IWE_AZURE_PROJECT ?? file.azureProject ?? "",
    azureDeploy: {
      pipeline: file.azureDeploy?.pipeline ?? ["build-", "deploy-"],
      versionParameter: file.azureDeploy?.versionParameter ?? "dockerTag",
      environmentParameter: file.azureDeploy?.environmentParameter ?? "environment",
      environments: (process.env.IWE_AZURE_ENVIRONMENTS ?? "")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
        .concat(
          process.env.IWE_AZURE_ENVIRONMENTS
            ? []
            : (file.azureDeploy?.environments ?? ["accept", "production"]),
        ),
    },
  };
}

/**
 * The settings, read once at startup — and again when the settings page writes them.
 *
 * Deliberately one object that is refilled rather than replaced: every module imports this by
 * reference, and a settings page that only took effect after a restart would be a settings page
 * nobody trusts.
 */
export const config: Config = load();

export function reloadConfig(): Config {
  return Object.assign(config, load());
}
