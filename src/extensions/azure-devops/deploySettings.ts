import { Effect } from "effect";
import { Settings } from "../../extension-host/api.ts";
import { bagList, bagString, resolveSetting } from "../../settings/server/legacySettings.ts";
import { AZURE_ENV, legacyDeployOf } from "./legacy.ts";

/**
 * The azure-devops extension's own server-wide deployment conventions, read back through the
 * contract.
 *
 * The chain every extension setting follows, stated once in src/settings/server/legacySettings.ts: what the
 * settings page wrote under `extensionSettings.azure-devops` — the extension's own
 * `globalSettings` declaration — wins, and when the bag is empty the legacy flat field answers
 * (through legacy.ts), which carries the default and the environment resolution
 * (IWE_AZURE_ENVIRONMENTS beats the file). A bag value that is not the right shape, or an empty
 * one, is not set: empty means unset.
 *
 * Organisation and project are not here: they belong to the extension's `azure.ts`, whose chain
 * also carries the per-workspace override.
 *
 * The exception is `pipeline`: the list holds exactly two names — how a build pipeline is named,
 * and its deploy twin — so a bag list that is not two names reads as not set and the legacy
 * field answers whole.
 */

export type DeploySettings = {
  /** `["build-", "deploy-"]`: how a build pipeline's name becomes its deploy pipeline's. */
  pipeline: readonly [string, string];
  versionParameter: string;
  environmentParameter: string;
  /** In the order they are deployed to, which is the order they are shown in. */
  environments: string[];
};

const FALLBACK: DeploySettings = {
  pipeline: ["build-", "deploy-"],
  versionParameter: "dockerTag",
  environmentParameter: "environment",
  environments: ["accept", "production"],
};

export function deploySettingsOf(
  bag: Record<string, string | string[]> | undefined,
  legacy: {
    pipeline?: readonly [string, string];
    versionParameter?: string;
    environmentParameter?: string;
    environments?: string[];
  },
): DeploySettings {
  const pipeline = bagList(bag, "pipeline");
  return {
    pipeline: resolveSetting<readonly [string, string]>({
      bag: pipeline && pipeline.length === 2 ? [pipeline[0]!, pipeline[1]!] : undefined,
      fallback: legacy.pipeline ?? FALLBACK.pipeline,
    }),
    versionParameter: resolveSetting({
      bag: bagString(bag, "versionParameter"),
      fallback: legacy.versionParameter ?? FALLBACK.versionParameter,
    }),
    environmentParameter: resolveSetting({
      bag: bagString(bag, "environmentParameter"),
      fallback: legacy.environmentParameter ?? FALLBACK.environmentParameter,
    }),
    environments: resolveSetting({
      bag: bagList(bag, "environments"),
      fallback: legacy.environments ?? FALLBACK.environments,
    }),
  };
}

/** The deployment conventions in effect: the extension's own bag, then the legacy flat field. */
export const deploySettings = (): Effect.Effect<DeploySettings, never, Settings> =>
  Effect.map(Settings, (settings) =>
    deploySettingsOf(settings.extensionSettings?.["azure-devops"], legacyDeployOf(settings)),
  );

/** The environment variable the `environments` declaration names, so the settings page's lock
 * and the fallback here cannot drift apart. */
export const DEPLOY_ENVIRONMENTS_ENV = AZURE_ENV.environments;
