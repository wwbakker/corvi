/**
 * The workspace module's public face: the config loader, the file schema, the workspace
 * resolution and the repository browser. The client half (`../client/`) has its own entry
 * points and is not re-exported here: it runs in the browser.
 *
 * The config vocabulary (`Config`, `Workspace`, `DEFAULT_WORKSPACE`) lives in
 * `@corvi/configuration/config` and is re-exported here so a consumer of this module needs one
 * import. Platform and the extension contract import the domain directly, because they must not
 * reach into a module's server half.
 */
export {
  configPath,
  expandTilde,
  readFile,
  readFileSync,
  mutateConfigFile,
  updateConfigFile,
} from "./config.ts";

export { reloadConfig, reloadConfigSync, runtimeConfig } from "../../capabilities/runtime.ts";

export {
  ConfigFile,
  Resolved,
  WorkspaceId,
  DirectoryName,
  EnvVarName,
  devicesFrom,
  remoteAccessFrom,
  workspacesFrom,
} from "./schema.ts";

export {
  workspaces,
  workspaceViews,
  workspaceById,
  workspaceOf,
  settingsOf,
  extensionEnabled,
  extensionNamesFor,
  repositoriesDirectoryOf,
} from "./workspaces.ts";

export {
  resolveDirectory,
  browse,
  remoteBranches,
} from "./repos.ts";

export { pairRemoteWorkspace, type PairedRemote } from "./pairRemote.ts";

export type { DirectoryEntryDto as Entry } from "@corvi/contracts/api";

export { DEFAULT_WORKSPACE, type Config, type Workspace } from "@corvi/configuration/config";
