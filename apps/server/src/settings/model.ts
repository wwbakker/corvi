/**
 * The settings module's pure vocabulary: the shape of the settings page's read and write,
 * shared by the server route and the browser page. Nothing here runs; the server half
 * (`./server/`) imports this, and the browser half reads it without touching a server file.
 */

import type { SettingsViewDto } from "@corvi/contracts/api";
import type { ConfigFileDto } from "@corvi/contracts/config";
import type { Config, ConfigFile } from "@corvi/configuration/config";
import type { ExtensionSetting, WorkspaceSetting } from "@corvi/contracts/integration";

/** What may be written: the config file's own shape. Everything is optional — an absent value
 * means "the default", which is what an empty file means. */
export type Settings = ConfigFile;

export type SettingsView = {
  /** Which file this is, so the page can say where to look when something is edited by hand. */
  path: string;
  /** What the file holds, as written. */
  file: Settings;
  /** What is actually in effect, defaults and environment included. */
  effective: Config;
  /** Setting to the environment variable currently overriding it. Those are shown as locked:
   * the variable wins, so writing the file would change nothing and look like a bug. */
  overridden: Record<string, string>;
  /** The extensions' server-wide settings an environment variable is currently overriding, by
   * extension name and setting key — the same locking as `overridden`, for the fields the
   * extensions declare on the settings page. */
  overriddenExtensions: Record<string, Record<string, string>>;
  /** What `worktreeCopy` is when it is not set, so the page can offer it back. */
  toolingDefault: string[];
  /** The extensions there are to enable, in the order they were loaded, each with the
   * per-workspace settings it declares — so the page needs no second request to render them. */
  extensions: {
    name: string;
    title: string;
    workspaceSettings: WorkspaceSetting[];
    globalSettings: ExtensionSetting[];
  }[];
};

// The hand-written vocabulary and the wire schemas must not drift: these fail to compile if
// either stops describing exactly the other. Both directions, because the page writes the file
// shape back to the server and reads the view shape from it.
const _settingsMatchesDto: ConfigFile = {} as ConfigFileDto;
const _settingsDtoMatchesSettings: ConfigFileDto = {} as ConfigFile;
const _viewMatchesDto: SettingsView = {} as SettingsViewDto;
const _viewDtoMatchesView: SettingsViewDto = {} as SettingsView;
