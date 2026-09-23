import { Effect } from "effect";
import { Settings, Workspace } from "@corvi/contracts/capabilities";
import { bagList, bagString, resolveSetting, type SettingBag } from "@corvi/configuration/settings";
import { AZURE_ENV } from "./env.ts";

/**
 * The azure-devops extension's own deployment conventions, read back through the contract and
 * down the one chain: the declared environment variable wins at every scope, then the workspace's
 * bag entry, then the global one, then the vendor default. A bag value that is not the right
 * shape, or an empty one, is not set: empty means unset.
 *
 * Organisation and project are not here: they belong to the extension's `azure.ts`, whose chain
 * also falls through to `az devops configure`.
 *
 * The exception is `pipeline`: the list holds exactly two names — how a build pipeline is named,
 * and its deploy twin — so a bag list that is not two names reads as not set and the default
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

const FALLBACK: DeploySettings = {
  pipeline: ["build-", "deploy-"],
  versionParameter: "dockerTag",
  environmentParameter: "environment",
  environments: ["accept", "production"],
};

export function deploySettingsOf(
  own: SettingBag | undefined,
  global?: SettingBag,
): DeploySettings {
  const pair = (bag: SettingBag | undefined): readonly [string, string] | undefined => {
    const pipeline = bagList(bag, "pipeline");
    return pipeline && pipeline.length === 2 ? [pipeline[0]!, pipeline[1]!] : undefined;
  };
  return {
    pipeline: resolveSetting<readonly [string, string]>({
      workspace: pair(own),
      global: pair(global),
      fallback: FALLBACK.pipeline,
    }),
    versionParameter: resolveSetting({
      workspace: bagString(own, "versionParameter"),
      global: bagString(global, "versionParameter"),
      fallback: FALLBACK.versionParameter,
    }),
    environmentParameter: resolveSetting({
      workspace: bagString(own, "environmentParameter"),
      global: bagString(global, "environmentParameter"),
      fallback: FALLBACK.environmentParameter,
    }),
    environments: resolveSetting({
      env: AZURE_ENV.environments,
      workspace: bagList(own, "environments"),
      global: bagList(global, "environments"),
      fallback: FALLBACK.environments,
      parse: (raw) =>
        raw
          .split(",")
          .map((environment) => environment.trim())
          .filter(Boolean),
    }),
  };
}

/** The deployment conventions in effect for this workspace: its bag entries over the global
 * bag's, then the declared environment variables. */
export const deploySettings = (): Effect.Effect<
  DeploySettings,
  never,
  Settings | Workspace
> =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const workspace = yield* Workspace;
    return deploySettingsOf(
      workspace.settings?.extensionSettings?.["azure-devops"],
      settings.extensionSettings?.["azure-devops"],
    );
  });

/** The environment variable the `environments` declaration names, so the settings page's lock
 * and the fallback here cannot drift apart. */
export const DEPLOY_ENVIRONMENTS_ENV = AZURE_ENV.environments;
