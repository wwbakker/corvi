/**
 * The configuration vocabulary: what a workspace is and what the resolved config holds.
 *
 * These are the types every module speaks — the platform (`@corvi/contracts/workspace`,
 * `apps/server/src/capabilities/shell.ts`), the integration contract, and the loaders — so they live in the
 * configuration package rather than in the module that happens to read the file. The loading,
 * the file schema and the settings precedence chain are the package's `./settings` and the
 * app's workspace server.
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
  /** Where the repository browser opens in this context: the global setting when it is absent.
   * The browser can walk anywhere from there — this only picks the starting point. */
  repositoriesDirectory?: string;
  /** Which extensions exist here, by name (see apps/server/src/extensions/). Absent means all of them. */
  extensions?: string[];
  /** Per-workspace settings declared by the extensions themselves: `extensionSettings[name][key]`
   * holds the field the extension's `workspaceSettings` declaration names, which is where the
   * extension reads it back. The core only carries it. */
  extensionSettings?: Record<string, Record<string, string>>;
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

/**
 * What Corvi tells an agent when you brief it about an idea: the plan path and the rule for the
 * phase, so a machine that has configured nothing still gets something useful. Editable in the
 * settings, where an empty field means this.
 *
 * `{id}`, `{title}`, `{plan}` and `{state}` are filled from the change (see
 * `ideationPromptFor`). Kept as one line here and wrapped by the settings page when written.
 */
export const DEFAULT_IDEATION_PROMPT =
  "You are helping me refine an idea before any work starts. The idea is \"{title}\" ({id}); " +
  "its plan is {plan}. Read the plan and the code, then help me sharpen the plan. While the " +
  "change is in Ideation, {plan} is the only file you should write — do not modify any repository. " +
  "Ask questions, propose options, and update the plan when we agree.";

/** File-based config, read once at startup. Environment variables still win, so tests and
 * one-off runs need no file. */
export type Config = {
  /** Where per-change directories (worktrees, change.json) are created. */
  changesRoot: string;
  /** Where completed changes are moved, so the changes root holds the work in flight. A
   * setting of its own rather than a child of `changesRoot`: an archive can live on another
   * disk, and listing the changes root never has to filter it out. */
  archiveRoot: string;
  /** Directory the repository browser opens on. The browser is unbounded — it can walk anywhere
   * under `/` from here — so this is a starting point, not a boundary. */
  repositoriesDirectory: string;
  /** Whether a notification plays the system sound; the settings page's one notification
   * decision so far. */
  notificationSound: boolean;
  /** Whether right-clicking shows the browser's own menu — Chromium's, which the host draws in the
   * app window because Electron has none of its own. A page that handles its own right-click (the
   * terminal, whose menu is tmux's) is untouched either way. See docs/manual/interface.md. */
  contextMenu: boolean;
  /** The prompt pasted into a change's terminal to brief an agent about an idea, with `{id}`,
   * `{title}`, `{plan}` and `{state}` filled in. Editable in the settings; an empty value means
   * `DEFAULT_IDEATION_PROMPT`. */
  ideationPrompt: string;
  /** The contexts you switch between. Never empty: when nothing is configured, the default
   * workspace stands in. */
  workspaces: Workspace[];
  /** IDE and build-tool directories copied from the repository into a new worktree, with the
   * paths inside them rewritten. Empty disables it. See `apps/server/src/capabilities/os.ts`. */
  worktreeCopy: string[];
  /** Settings the extensions declared, stored under their own name:
   * `extensionSettings[name][key]` holds the field the extension's `globalSettings`
   * declaration names, which is where the extension reads it back. A value is one string or a
   * list of them. The core carries the bag without looking inside; the flat settings are the
   * fallback the extension reads go through when the bag is empty. */
  extensionSettings?: Record<string, Record<string, string | string[]>>;
};

/**
 * The config file's own shape, as it is written on disk: every key optional, because an absent
 * value means "the default". This is also the settings page's write shape (the settings
 * module's `Settings`). The Effect Schema that decodes it lives in
 * `apps/server/src/workspace/server/schema.ts`, which checks itself against this type.
 */
export type ConfigFile = {
  changesRoot?: string;
  archiveRoot?: string;
  /** Directory the repository browser opens on; see `Config.repositoriesDirectory`. Absent means
   * `$HOME`. */
  repositoriesDirectory?: string;
  notificationSound?: boolean;
  /** Whether right-clicking shows the browser's own menu; see `Config.contextMenu`. An absent value
   * means yes. */
  contextMenu?: boolean;
  /** The prompt that briefs an agent about an idea; see `Config.ideationPrompt`. */
  ideationPrompt?: string;
  /** The contexts you switch between, as the file holds them. Decoded with the per-item
   * tolerance in `workspacesFrom`, so the schema sees them more loosely than this. */
  workspaces?: Workspace[];
  worktreeCopy?: string[];
  /** Settings the extensions declared, under their own name: `extensionSettings[name][key]`,
   * one string or a list of strings per key. */
  extensionSettings?: Record<string, Record<string, string | string[]>>;
};
