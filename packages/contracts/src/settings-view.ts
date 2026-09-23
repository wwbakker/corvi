/** The settings page's read and write vocabulary, shared by the server route and the browser
 * page. The wire schemas are `@corvi/contracts/api`'s; this is the type the two halves speak.
 */
import type { SettingsViewDto } from "./api.ts";
import type { ConfigFileDto, ResolvedDto, WorkspaceDto } from "./config.ts";
import type { ExtensionSetting } from "./integration.ts";

/** What may be written: the config file's own shape — the settings at the top level and each
 * workspace's `settings` overrides of them. Everything is optional — an absent value means "the
 * default", which is what an empty file means. The workspaces are typed as they are edited (the
 * wire carries them loosely; `workspacesFrom` applies the tolerance). */
export type Settings = Omit<ConfigFileDto, "workspaces"> & { workspaces?: WorkspaceDto[] };

export type SettingsView = {
  /** Which file this is, so the page can say where to look when something is edited by hand. */
  path: string;
  /** What the file holds, as written. */
  file: Settings;
  /** What is actually in effect at the global level, defaults and environment included. What
   * applies inside a workspace composes from this and the draft: a field the workspace leaves
   * empty inherits the global value, draft edits included (the chain, `@corvi/configuration/settings`). */
  effective: ResolvedDto;
  /** Setting to the environment variable currently overriding it. Those are shown as locked:
   * the variable wins at every scope, so writing the file would change nothing and look like a
   * bug. */
  overridden: Record<string, string>;
  /** The extensions' settings an environment variable is currently overriding, by extension name
   * and setting key — the same locking as `overridden`, at both scopes, for the fields the
   * extensions declare on the settings page. */
  overriddenExtensions: Record<string, Record<string, string>>;
  /** What `worktreeCopy` is when it is not set, so the page can offer it back. */
  toolingDefault: string[];
  /** The extensions there are to enable, in the order they were loaded, each with the settings
   * it declares — so the page needs no second request to render them, at either scope. */
  extensions: {
    name: string;
    title: string;
    settings: ExtensionSetting[];
  }[];
};

// The hand-written vocabulary and the wire schemas must not drift: these fail to compile if
// either stops describing exactly the other. Both directions, because the page writes the file
// shape back to the server and reads the view shape from it.
const _viewMatchesDto: SettingsView = {} as SettingsViewDto;
const _viewDtoMatchesView: SettingsViewDto = {} as SettingsView;
