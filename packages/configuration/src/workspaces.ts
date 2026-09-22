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

/** Whether an integration exists in this workspace. Absent means all of them: a workspace that
 * names no integrations has every one. This is the one enablement rule, shared by every surface
 * that asks. */
export const extensionEnabled = (workspace: WorkspaceDto, name: string): boolean =>
  workspace.extensions ? workspace.extensions.includes(name) : true;
