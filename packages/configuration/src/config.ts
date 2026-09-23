/**
 * The configuration vocabulary: what a workspace is and what the resolved config holds.
 *
 * These are the types every module speaks — the platform (`@corvi/contracts/workspace`,
 * `apps/server/src/capabilities/shell.ts`), the integration contract, and the loaders — so they live in
 * the configuration package rather than in the module that happens to read the file. The loading,
 * the file schema and the settings precedence chain are the package's `./settings` and the
 * app's workspace server.
 */

/**
 * The settings, complete: every setting Corvi knows, in the one shape both levels hold. At the
 * global level these are the settings; inside a workspace they are the overrides of them, key by
 * key. Every key is optional — an absent value means "not set" and the next level down answers.
 */
export type SettingsOverrides = {
  /** Where per-change directories (worktrees, change.json) are created. */
  changesRoot?: string;
  /** Where completed changes are moved, so the changes root holds the work in flight. A
   * setting of its own rather than a child of `changesRoot`: an archive can live on another
   * disk, and listing the changes root never has to filter it out. */
  archiveRoot?: string;
  /** Directory the repository browser opens on. The browser is unbounded — it can walk anywhere
   * under `/` from here — so this is a starting point, not a boundary. */
  repositoriesDirectory?: string;
  /** Whether a notification plays the system sound; the settings page's one notification
   * decision so far. */
  notificationSound?: boolean;
  /** Whether right-clicking shows the browser's own menu — Chromium's, which the host draws in the
   * app window because Electron has none of its own. A page that handles its own right-click (the
   * terminal, whose menu is tmux's) is untouched either way. See docs/manual/interface.md. */
  contextMenu?: boolean;
  /** The text behind the built-in `brief` action, with the change's facts filled in. An empty
   * value means that action's shipped body (packages/actions/builtins/brief.md). */
  ideationPrompt?: string;
  /** IDE and build-tool directories copied from the repository into a new worktree, with the
   * paths inside them rewritten. Empty disables it. See `apps/server/src/capabilities/os.ts`. */
  worktreeCopy?: string[];
  /** Which extensions exist here, by name (see apps/server/src/integrations/). Absent means all
   * of them; an empty list means none. */
  extensions?: string[];
  /** Settings the extensions declared: `extensionSettings[name][key]` holds the field the
   * extension's `settings` declaration names, which is where the extension reads it back. A
   * value is one string or a list of them. The core carries the bag without looking inside. */
  extensionSettings?: Record<string, Record<string, string | string[]>>;
  /**
   * Added to the environment of every CLI run in this scope. This is how two clients stop
   * fighting over one login: `GH_CONFIG_DIR` for another GitHub account, `AZURE_CONFIG_DIR` for
   * another tenant, `JIRA_API_TOKEN` for another site. Entries resolve per key: a workspace
   * entry beats the global one for its key and leaves the others inherited. `~` is expanded.
   */
  env?: Record<string, string>;
};

/**
 * A context you work in: a client, or your own projects. Which changes you are looking at, and
 * where its repositories live and which integrations apply, since a personal project has no Jira
 * issue and no Azure pipeline and should not be asked about either. An identity plus a scope:
 * `settings` overrides the global settings key by key.
 */
export type Workspace = {
  /** Stable, and recorded in a change: renaming the name must not orphan anything. */
  id: string;
  name: string;
  /** This workspace's settings: the same shape as the global level, overriding it key by key. */
  settings?: SettingsOverrides;
};

export { DEFAULT_WORKSPACE } from "@corvi/contracts/config";

export type EffectiveSettings = {
  changesRoot: string;
  archiveRoot: string;
  repositoriesDirectory: string;
  notificationSound: boolean;
  contextMenu: boolean;
  ideationPrompt: string;
  worktreeCopy: string[];
  /** Which extensions exist here; `undefined` means all of them. */
  extensions?: string[];
  /** The extension bags, merged per extension and per key across the two levels. */
  extensionSettings: Record<string, Record<string, string | string[]>>;
  /** The environment added to every CLI run here, `~` expanded at use: the global entries and
   * the workspace's, the workspace's winning per key. */
  env: Record<string, string>;
};

/**
 * File-based config, read once at startup and resolved into what the rest of the code reads:
 * the global scope's answers (environment variable → file → default) on the top level, and each
 * workspace's overrides beside them. `settingsFor` (`./settings`) resolves one scope from the
 * two. Environment variables still win, so tests and one-off runs need no file.
 */
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
  /** The prompt pasted into a change's terminal to brief an agent about an idea, with the
   * change's facts filled in (`@corvi/actions/render`). Editable in the settings; an empty
   * value means the built-in `brief` action's body. */
  ideationPrompt: string;
  /** IDE and build-tool directories copied from the repository into a new worktree, with the
   * paths inside them rewritten. Empty disables it. See `apps/server/src/capabilities/os.ts`. */
  worktreeCopy: string[];
  /** Which extensions exist at the global level. Absent means all of them; an empty list means
   * none. A workspace's own list overrides it. */
  extensions?: string[];
  /** The global extension settings bag: `extensionSettings[name][key]` holds the field the
   * extension's `settings` declaration names, which is where the extension reads it back. A
   * value is one string or a list of them. The core carries the bag without looking inside; a
   * workspace's bag overrides it key by key. */
  extensionSettings?: Record<string, Record<string, string | string[]>>;
  /** The global entries of the environment added to every CLI run, `~` expanded at use. A
   * workspace's `env` overrides them key by key. */
  env: Record<string, string>;
  /** The contexts you switch between. Never empty: when nothing is configured, the default
   * workspace stands in. Each one's `settings` holds its overrides. */
  workspaces: Workspace[];
};

/**
 * The config file's own shape, as it is written on disk: every key optional, because an absent
 * value means "the default". This is also the settings page's write shape (the settings
 * module's `Settings`). The Effect Schema that decodes it lives in
 * `apps/server/src/workspace/server/schema.ts`, which checks itself against this type.
 */
export type ConfigFile = SettingsOverrides & {
  /** The contexts you switch between, as the file holds them. Decoded with the per-item
   * tolerance in `workspacesFrom`, so the schema sees them more loosely than this. */
  workspaces?: Workspace[];
};
