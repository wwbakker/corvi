import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Effect, Schema } from "effect";
import { ConfigFile, workspacesFrom } from "./schemas/config.ts";
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
    pipeline: readonly [string, string];
    versionParameter: string;
    environmentParameter: string;
    /** In the order they are deployed to, which is the order they are shown in. */
    environments: string[];
  };
};

// Pure sync path logic; nothing to wrap in an Effect.
export const configPath = (): string =>
  process.env.IWE_CONFIG ?? join(homedir(), ".config", "iwe", "config.json");

export const expandTilde = (path: string): string =>
  path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

const defaults: Pick<Config, "changesRoot" | "reposRoot"> = {
  changesRoot: join(homedir(), "changes"),
  reposRoot: join(homedir(), "Repos"),
};

/**
 * The config file, decoded through its Schema (src/schemas/config.ts).
 *
 * Reconciling the synchronous startup read with Effect: the read and decode are built as an
 * Effect so the file boundary has exactly one implementation, but it is run with
 * `Effect.runSync` at startup — config is needed before the first request, this is one small
 * local file, and an async dance here would only move the await into Bun.serve's first request.
 * Everything async (the settings page's write path) composes the same Effect.
 */
const decodeConfigFile = (text: string): Effect.Effect<ConfigFile> =>
  Schema.decodeUnknown(Schema.parseJson(ConfigFile), { onExcessProperty: "preserve" })(text).pipe(
    // Tolerance the README documents: an invalid config file reads as "nothing configured" —
    // what the old try/catch around JSON.parse gave every machine that has no config at all.
    Effect.orElseSucceed(() => ({})),
  );

/** The file's contents as an Effect: unreadable or undecodable means "nothing configured". */
export const readFileEffect = (path: string = configPath()): Effect.Effect<ConfigFile> =>
  Effect.gen(function* () {
    const text = yield* Effect.try(() => readFileSync(path, "utf8"));
    return yield* decodeConfigFile(text);
  }).pipe(
    // Same tolerance, for a file that cannot be read at all: nothing configured.
    Effect.catchAll(() => Effect.succeed({})),
  );

/** What is in the file, as it is written. Invalid JSON reads as "nothing configured", which is
 * how IWE has always started on a machine that has no config at all.
 *
 * Sync facade over readFileEffect (run with Effect.runSync; see the note above): config is
 * needed synchronously at startup, so this stays. */
export function readFile(): ConfigFile {
  // Sync on purpose: config is needed before the first request, and this is one small file.
  return Effect.runSync(readFileEffect());
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

/** The file and the environment, resolved into what the rest of the code reads. The precedence
 * chain is unchanged: environment wins over file, file over defaults. The per-workspace
 * tolerance (skip entries without a truthy id and name) is applied by workspacesFrom, exactly
 * where the old inline filter sat. */
function load(): Config {
  const file = readFile();
  const workspaces = workspacesFrom(file.workspaces);
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
    workspaces: workspaces.length ? workspaces : [DEFAULT_WORKSPACE],
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

/** The same refill as an Effect, for the settings page's Effect write path. The object is
 * mutated in place (Object.assign) — modules hold it by reference. */
export const reloadConfigEffect = Effect.sync(() => reloadConfig());

/** Refill the one config object in place. Sync, because every caller of the settings write is
 * synchronous today and the object identity must not change.
 *
 * Sync facade; the Effect form is reloadConfigEffect, which the settings write path uses. */
export function reloadConfig(): Config {
  return Object.assign(config, load());
}
