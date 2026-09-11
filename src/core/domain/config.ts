/**
 * The configuration vocabulary: what a workspace is and what the resolved config holds.
 *
 * These are the types the platform (`src/core/platform/effect/tags.ts`,
 * `src/core/platform/capabilities/sh.ts`), the extension contract
 * (`src/core/host/api/`) and every module speak, so they live in the ubiquitous language rather
 * than in the workspace module's server half. The loading, the file schema and the settings
 * precedence chain stay with the code that runs them (`src/workspace/server/` and
 * `src/settings/server/`).
 */

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
  /** Which extensions exist here, by name (see src/extensions/). Absent means all of them. */
  extensions?: string[];
  /** Per-workspace settings declared by the extensions themselves: `extensionSettings[name][key]`
   * holds the field the extension's `workspaceSettings` declaration names, which is where the
   * extension reads it back. The core only carries it. */
  extensionSettings?: Record<string, Record<string, string>>;
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

/** The workspace a change without one belongs to: the first one, which for everybody who has
 * not configured any is the only one. There is no such thing as no workspaces: a machine that
 * has not configured any gets this one. */
export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "Default workspace" };

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
  /** Whether a notification plays the system sound; the settings page's one notification
   * decision so far. */
  notificationSound: boolean;
  /** Azure DevOps organisation and project; empty means "whatever az devops configure holds". */
  azureOrganization: string;
  azureProject: string;
  /** The contexts you switch between. Never empty: when nothing is configured, the default
   * workspace stands in. */
  workspaces: Workspace[];
  /** IDE and build-tool directories copied from the repository into a new worktree, with the
   * paths inside them rewritten. Empty disables it. See `src/core/platform/tooling.ts`. */
  worktreeCopy: string[];
  /** Where out-of-tree extension modules live: .ts files, or directories whose immediate .ts
   * files and any `index.ts` in a subdirectory are loaded beside the built-ins (src/core/host/index.ts). `~` is
   * expanded and duplicates dropped; ~/.config/iwe/extensions is searched in addition, when
   * it exists. A change here needs a restart — extensions load once, at startup. */
  extensionPaths: string[];
  /** Settings the extensions declared, stored under their own name:
   * `extensionSettings[name][key]` holds the field the extension's `globalSettings`
   * declaration names, which is where the extension reads it back. A value is one string or a
   * list of them. The core carries the bag without looking inside; the flat settings are the
   * fallback the extension reads go through when the bag is empty. */
  extensionSettings?: Record<string, Record<string, string | string[]>>;
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

/**
 * The config file's own shape, as it is written on disk: every key optional, because an absent
 * value means "the default". This is also the settings page's write shape (the settings
 * module's `Settings`). The Effect Schema that decodes it lives in
 * `src/workspace/server/schema.ts`, which checks itself against this type.
 */
export type ConfigFile = {
  changesRoot?: string;
  reposRoot?: string;
  reposStart?: string;
  notificationSound?: boolean;
  azureOrganization?: string;
  azureProject?: string;
  /** The contexts you switch between, as the file holds them. Decoded with the per-item
   * tolerance in `workspacesFrom`, so the schema sees them more loosely than this. */
  workspaces?: Workspace[];
  worktreeCopy?: string[];
  extensionPaths?: string[];
  /** Settings the extensions declared, under their own name: `extensionSettings[name][key]`,
   * one string or a list of strings per key. */
  extensionSettings?: Record<string, Record<string, string | string[]>>;
  azureDeploy?: {
    pipeline?: readonly [string, string];
    versionParameter?: string;
    environmentParameter?: string;
    environments?: string[];
  };
};
