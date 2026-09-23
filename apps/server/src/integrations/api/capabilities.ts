/** The capability surface the host provides to every contributed effect. The canonical
 * definitions live in `@corvi/contracts/capabilities`; this module is the app's one import
 * while the features still live under `src`.
 */
export {
  Bus,
  Cache,
  Changes,
  ExtensionStore,
  GitFacts,
  Settings,
  Shell,
  Workspace,
  type Capabilities,
  type ExtensionStoreShape,
  type Result,
  type ShellShape,
  type Startup,
} from "@corvi/contracts/capabilities";
