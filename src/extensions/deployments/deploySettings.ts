import { config } from "../../workspace/server/index.ts";
import { bagList, bagString, resolveSetting } from "../../settings/server/legacySettings.ts";

/**
 * The deployments extension's own server-wide settings, read back.
 *
 * The chain every extension setting follows, stated once in src/settings/server/legacySettings.ts: what the
 * settings page wrote under `extensionSettings.deployments` — the extension's own
 * `globalSettings` declaration — wins, and when the bag is empty the flat config field answers,
 * which carries the default and the environment resolution (IWE_AZURE_ENVIRONMENTS beats the
 * file). A bag value that is not the right shape, or an empty one, is not set: empty means unset.
 *
 * Organisation and project are not here: they belong to the shared azure client, whose chain
 * also carries the per-workspace override (src/core/integrations/azure.ts's `azureOf`).
 *
 * The exception is `pipeline`: the list holds exactly two names — how a build pipeline is named,
 * and its deploy twin — so a bag list that is not two names reads as not set and the flat field
 * answers whole.
 */

export type DeploySettings = {
  /** `["build-", "deploy-"]`: how a build pipeline's name becomes its deploy pipeline's. */
  pipeline: readonly [string, string];
  versionParameter: string;
  environmentParameter: string;
  /** In the order they are deployed to, which is the order they are shown in. */
  environments: string[];
};

const bag = (): Record<string, string | string[]> | undefined =>
  config.extensionSettings?.deployments;

// Pure and synchronous: nothing for an Effect to wrap.
export function deploySettings(): DeploySettings {
  const own = bag();
  const pipeline = bagList(own, "pipeline");
  return {
    pipeline: resolveSetting<readonly [string, string]>({
      bag: pipeline && pipeline.length === 2 ? [pipeline[0]!, pipeline[1]!] : undefined,
      fallback: config.azureDeploy.pipeline,
    }),
    versionParameter: resolveSetting({
      bag: bagString(own, "versionParameter"),
      fallback: config.azureDeploy.versionParameter,
    }),
    environmentParameter: resolveSetting({
      bag: bagString(own, "environmentParameter"),
      fallback: config.azureDeploy.environmentParameter,
    }),
    environments: resolveSetting({
      bag: bagList(own, "environments"),
      fallback: config.azureDeploy.environments,
    }),
  };
}
