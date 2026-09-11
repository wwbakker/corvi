import { config } from "./config.ts";
import { bagList, bagString, resolveSetting } from "./legacySettings.ts";

/**
 * The deployments extension's server-wide settings, read back.
 *
 * The chain every extension setting follows, stated once in src/legacySettings.ts: what the
 * settings page wrote under `extensionSettings.deployments` — the extension's own
 * `globalSettings` declaration — wins, and when the bag is empty the flat config field answers,
 * which carries the default and the environment resolution (IWE_AZURE_ORG, IWE_AZURE_PROJECT,
 * IWE_AZURE_ENVIRONMENTS beat the file). A bag value that is not the right shape, or an empty
 * one, is not set: empty means unset.
 *
 * The exception is `pipeline`: the list holds exactly two names — how a build pipeline is named,
 * and its deploy twin — so a bag list that is not two names reads as not set and the flat field
 * answers whole.
 */

export type DeploySettings = {
  /** Empty means "whatever az devops configure holds". */
  organization?: string;
  project?: string;
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
    organization: resolveSetting<string | undefined>({
      bag: bagString(own, "organization"),
      fallback: config.azureOrganization || undefined,
    }),
    project: resolveSetting<string | undefined>({
      bag: bagString(own, "project"),
      fallback: config.azureProject || undefined,
    }),
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
