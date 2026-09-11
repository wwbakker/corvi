import { loadAll, loadDiscovered } from "./discover.ts";
import { loaded } from "./registry.ts";

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
 * Contributed handlers are Effects (src/extensions/api.ts). The host runs each one inside
 * `capabilitiesLayer(workspaceOf(change))` — the request's workspace plus the four services —
 * so an extension's requirements arrive through the R channel, with no ambient state and no
 * bridging layer. The built-ins are joined, after them, by out-of-tree
 * extensions discovered from the config and imported from disk — through the same
 * install/factory path, so the contract (docs/guides/extensions.md) does not change with the
 * extension's address.
 */

// The built-ins, in dashboard order: the agents' furniture first (it is what names windows
// everywhere), then local changes, then CI, then the ticket cards. Each is a module whose
// default export describes it — a static value, or a factory for one. Deployments owns no
// card — its page is offered beside the list, not on it — so it comes last and does not
// disturb the cards' order.
import agentsExtension from "./agents/index.ts";
import gitExtension from "./git/index.ts";
import ciExtension from "./ci/index.ts";
import jiraExtension from "./jira/index.ts";
import githubIssuesExtension from "./github-issues/index.ts";
import deploymentsExtension from "./deployments/index.ts";

// Awaited at module scope, so the server does not start listening before the extensions have
// loaded, and a test importing this file sees the fully-loaded registry. Out-of-tree, after
// the built-ins: the configured paths, then the implicit default directory, discovered and
// imported from disk through the same install path as the above.
await loadAll([
  agentsExtension,
  gitExtension,
  ciExtension,
  jiraExtension,
  githubIssuesExtension,
  deploymentsExtension,
]);
await loadDiscovered();

// The public surface: every symbol the rest of the server imports from here, whichever module
// implements it (or from ./registry.ts, which src/terminal.ts reads directly).
export {
  install,
  loaded,
  windowPresenters,
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
  completionStepsFor,
  descriptionSectionsFor,
  extensionsFor,
  looseEndContributorsFor,
  pagesFor,
  summaryContributorsFor,
  titleSourcesFor,
  wizardStepsFor,
  type PageInfo,
  type WizardStepInfo,
} from "./selectors.ts";
export {
  provision,
  repoStatusOf,
  runCard,
  statusOne,
  type ProvisionResult,
} from "./effects.ts";
export { dispatchExtensionRoute } from "./dispatch.ts";

/** Re-exported for the contributors' convenience; the type lives in types.ts with the rest of
 * the dashboard's vocabulary. */
export type { CompletionStep } from "../types.ts";
