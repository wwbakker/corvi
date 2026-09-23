import { migrateExtensionSettings } from "./migrate.ts";
import { unknownIntegrationNames } from "./included.ts";
import { runtimeConfig, setMigrator } from "../workspace/server/index.ts";

/**
 * The included integrations' public face: the composed list (apps/server/src/integrations/included.ts) and
 * the queries, effects and dispatcher the rest of the server imports. There is no loader: the
 * modules are ordinary code, imported once, and a workspace's `extensions` list decides which
 * of them apply to it.
 *
 * The host answers the core's one question — which integrations exist for this workspace — with
 * a plain filtered list. There are no singleton slots and no arbitration: contributions are
 * additive, and enablement is per request, read live from the config, which is why toggling an
 * integration on the settings page takes effect at once.
 *
 * Contributed handlers are Effects (apps/server/src/integrations/types.ts). The host runs each one inside
 * `capabilitiesLayer(workspaceOf(change), name)` — the request's workspace, the four services
 * and the name-bound `ExtensionStore` — so an integration's requirements arrive through the R
 * channel, with no ambient state and no bridging layer.
 */

// The retired names fold into the integrations' own settings, in memory: hand-edited files land
// normalized without a settings save. The config calls back here on every refill, so a settings
// write migrates too (apps/server/src/settings/server/settings.ts migrates before writing).
setMigrator(migrateExtensionSettings);
migrateExtensionSettings(runtimeConfig().workspaces);

// A workspace's enablement list is hand-editable; a name nothing answers for is a typo worth
// saying once at startup rather than a silently dead surface.
for (const workspace of runtimeConfig().workspaces) {
  for (const name of unknownIntegrationNames(workspace.extensions)) {
    console.error(
      `workspace "${workspace.id}" enables "${name}", which is not an included integration`,
    );
  }
}

// The public surface: every symbol the rest of the server imports from here, whichever module
// implements it.
export {
  loaded,
  type CompiledRoute,
  type LoadedIntegration,
} from "./loaded.ts";
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
export { dispatchIntegrationRoute } from "./dispatch.ts";

/** Re-exported for the contributors' convenience; the type lives in domain/change.ts with the
 * rest of the dashboard's vocabulary. */
export type { CompletionStep } from "../domain/change.ts";
