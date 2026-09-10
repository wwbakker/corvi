import { config } from "./config.ts";

/**
 * The deployments extension's server-wide settings, read back.
 *
 * The chain is the one every migrated setting follows: what the settings page wrote under
 * `extensionSettings.deployments` — the extension's own `globalSettings` declaration — wins,
 * and when the bag is empty the legacy config field answers, which carries the default and the
 * environment resolution (IWE_AZURE_ORG, IWE_AZURE_PROJECT, IWE_AZURE_ENVIRONMENTS beat the
 * file, exactly as they always have). A bag value that is not the right shape, or an empty one,
 * is not set: empty means unset.
 *
 * The exception is `pipeline`: the list holds exactly two names — how a build pipeline is named,
 * and its deploy twin — so a bag list that is not two names reads as not set and the legacy
 * field answers whole.
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

/** One string field of the bag: a non-string, or an empty one, is not set. */
const bagString = (
  values: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined => {
  const value = values?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

/** One list field of the bag: only a list of non-empty strings counts, and an empty list is
 * not set — empty means unset, which is what clearing every row on the page means. */
const bagList = (
  values: Record<string, string | string[]> | undefined,
  key: string,
): string[] | undefined => {
  const value = values?.[key];
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((v): v is string => typeof v === "string" && Boolean(v.trim()));
  return names.length ? names : undefined;
};

// Pure and synchronous: nothing for an Effect to wrap.
export function deploySettings(): DeploySettings {
  const own = bag();
  const pipeline = bagList(own, "pipeline");
  return {
    organization: bagString(own, "organization") ?? (config.azureOrganization || undefined),
    project: bagString(own, "project") ?? (config.azureProject || undefined),
    pipeline:
      pipeline && pipeline.length === 2
        ? [pipeline[0]!, pipeline[1]!]
        : config.azureDeploy.pipeline,
    versionParameter: bagString(own, "versionParameter") ?? config.azureDeploy.versionParameter,
    environmentParameter:
      bagString(own, "environmentParameter") ?? config.azureDeploy.environmentParameter,
    environments: bagList(own, "environments") ?? config.azureDeploy.environments,
  };
}
