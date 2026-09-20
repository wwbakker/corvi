import { loadAll, loadDiscovered } from "./discover.ts";
import { loaded } from "./registry.ts";
import { migrateExtensionSettings } from "./migrate.ts";
import { config, setMigrator } from "../workspace/server/index.ts";

/**
 * The extension host's public face: loads the built-in extensions, then the out-of-tree ones,
 * and re-exports the pieces the rest of the server imports. The implementation is split by
 * what it is — the registry leaf (./registry.ts), discovery and loading (./discover.ts), the
 * workspace selectors (./selectors.ts), running what extensions contribute (./effects.ts), and
 * the route dispatcher (./dispatch.ts) — while this file stays the single entry point every
 * importer uses.
 *
 * The host answers the core's one question — which extensions exist for this workspace — with a
 * plain filtered list. There are no singleton slots and no arbitration: contributions are
 * additive, and enablement is per request, read live from the config, which is why toggling an
 * extension on the settings page takes effect at once.
 *
 * Contributed handlers are Effects (src/extension-host/api.ts). The host runs each one inside
 * `capabilitiesLayer(workspaceOf(change), name)` — the request's workspace, the four services
 * and the name-bound `ExtensionStore` — so an extension's requirements arrive through the R
 * channel, with no ambient state and no bridging layer. The built-ins are joined, after them, by out-of-tree
 * extensions discovered from the config and imported from disk — through the same
 * install/factory path. Replacement with explicit composition is tracked in
 * docs/plans/architecture-refactor.md.
 */

// The built-ins, in dashboard order: the agents' furniture first (it is what names windows
// everywhere), then local changes, then the pull requests and pipelines, then the ticket cards.
// Each is a module whose default export describes it — a static value, or a factory for one.
// The Azure DevOps page is offered beside the list, not on it — and review owns a change tab
// rather than a card, so the two come last with leftovers and do not disturb the cards' order.
import agentsExtension from "../extensions/agents/index.ts";
import gitExtension from "../extensions/git/index.ts";
import githubExtension from "../extensions/github/index.ts";
import jiraExtension from "../extensions/jira/index.ts";
import githubIssuesExtension from "../extensions/github-issues/index.ts";
import azureDevopsExtension from "../extensions/azure-devops/index.ts";
import leftoversExtension from "../extensions/leftovers/index.ts";
import reviewExtension from "../extensions/review/index.ts";
import notesExtension from "../extensions/notes/index.ts";

// Awaited at module scope, so the server does not start listening before the extensions have
// loaded, and a test importing this file sees the fully-loaded registry. Out-of-tree, after
// the built-ins: the configured paths, then the implicit default directory, discovered and
// imported from disk through the same install path as the above.
await loadAll([
  agentsExtension,
  gitExtension,
  githubExtension,
  jiraExtension,
  githubIssuesExtension,
  azureDevopsExtension,
  leftoversExtension,
  reviewExtension,
  notesExtension,
]);
await loadDiscovered();

// The retired names fold into the extensions' own settings, in memory: hand-edited files
// land normalized without a settings save. The config calls back here on every refill, so a
// settings write migrates too (src/settings/server/settings.ts migrates before writing).
setMigrator(migrateExtensionSettings);
migrateExtensionSettings(config.workspaces);

// The public surface: every symbol the rest of the server imports from here, whichever module
// implements it.
export {
  install,
  loaded,
  type CompiledRoute,
  type LoadedExtension,
} from "./registry.ts";
export {
  defaultExtensionDir,
  extensionModulePaths,
  loadAll,
  loadDiscovered,
} from "./discover.ts";
export {
  cardForExtension,
  cardsFor,
  changeTabsFor,
  extensionsFor,
  pagesFor,
  widgetsFor,
  wizardStepsFor,
  type ChangeTabInfo,
  type DashboardWidgetInfo,
  type PageInfo,
  type WizardStepInfo,
} from "./selectors.ts";
export {
  repoStatusOf,
  runCard,
  statusOne,
} from "./effects.ts";
export { dispatchExtensionRoute } from "./dispatch.ts";

/** Re-exported for the contributors' convenience; the type lives in domain/change.ts with the
 * rest of the dashboard's vocabulary. */
export type { CompletionStep } from "../domain/change.ts";
