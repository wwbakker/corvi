/** One server-wide setting an extension declares: rendered by the settings page in a section
 * per extension, stored under `extensionSettings[name][key]` in the config file. */
export type ExtensionSetting = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** A list of strings rather than one value, edited as rows. */
  list?: boolean;
  /** The environment variable that overrides this setting, shown locked when set — the page
   * cannot fight it. The override still works through the core config field the extension reads
   * back, and the precedence is: extension setting (page/file) wins, then that config field
   * (which carries defaults + environment resolution), so an env var keeps beating the page. */
  env?: string;
};

/** One per-workspace string field an extension declares: rendered by the settings page and
 * stored under `workspace.extensionSettings[name][key]` — plain data, owned by the extension. */
export type WorkspaceSetting = {
  /** The key under `extensionSettings[name]` this field is stored as. */
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
};
