/**
 * The workspace module's public face: the config loader, the file schema, the workspace
 * resolution and the repository browser. The client half (`../client/`) has its own entry
 * points and is not re-exported here: it runs in the browser.
 *
 * The config vocabulary (`Config`, `Workspace`, `DEFAULT_WORKSPACE`) lives in
 * `src/domain/config.ts` and is re-exported here so a consumer of this module needs one
 * import. Platform and the extension contract import the domain directly, because they must not
 * reach into a module's server half.
 */
export {
  config,
  configPath,
  expandTilde,
  readFile,
  readFileSync,
  reloadConfig,
  reloadConfigSync,
  setMigrator,
} from "./config.ts";

export {
  ConfigFile,
  Resolved,
  WorkspaceId,
  DirectoryName,
  EnvVarName,
  workspacesFrom,
} from "./schema.ts";

export {
  workspaces,
  workspaceById,
  workspaceOf,
  extensionEnabled,
  reposStartOf,
} from "./workspaces.ts";

export {
  resolveInRoot,
  startPath,
  browse,
  remoteBranches,
  absolutePath,
} from "./repos.ts";

export type { Entry } from "../model.ts";

export { DEFAULT_WORKSPACE, type Config, type Workspace } from "../../domain/config.ts";
