/** Workspace selection, pure: which context a change belongs to and what that context implies.
 * The app supplies the resolved config (`runtimeConfig()`); an integration reads the same values
 * through the `Settings` capability.
 */
import type { WorkspaceDto } from "@corvi/contracts/config";

/** The workspace with this id, or the first one — where every change without one belongs. */
export const workspaceById = (
  workspaces: readonly WorkspaceDto[],
  id?: string,
): WorkspaceDto => workspaces.find((workspace) => workspace.id === id) ?? workspaces[0]!;

export const workspaceOf = (
  workspaces: readonly WorkspaceDto[],
  change: { readonly workspace?: string },
): WorkspaceDto => workspaceById(workspaces, change.workspace);

/** The extensions this scope has: its own list, the global one when it names none, and every
 * extension there is when neither does. Absent means all of them; an empty list means none. */
export const extensionsFor = (
  config: { readonly extensions?: readonly string[] },
  workspace: { readonly settings?: { readonly extensions?: readonly string[] } },
): readonly string[] | undefined => workspace.settings?.extensions ?? config.extensions;

/** Whether an integration exists in this workspace. The one enablement rule, shared by every
 * surface that asks: the workspace's list overrides the global one, and no list at all means
 * every extension. */
export const extensionEnabled = (
  config: { readonly extensions?: readonly string[] },
  workspace: { readonly settings?: { readonly extensions?: readonly string[] } },
  name: string,
): boolean => {
  const enabled = extensionsFor(config, workspace);
  return enabled ? enabled.includes(name) : true;
};
