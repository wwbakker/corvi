import { Effect } from "effect";
import type { Config } from "@corvi/configuration/config";
import { Cache, Settings, Shell, Workspace } from "@corvi/contracts/capabilities";
import { bagString, resolveSetting } from "@corvi/configuration/settings";
import { AZURE_ENV } from "./env.ts";

/**
 * Which Azure DevOps this workspace means, read through the contract.
 *
 * The chain, stated once: the declared environment variables (CORVI_AZURE_ORG /
 * CORVI_AZURE_PROJECT) win at every scope; then the per-workspace settings bag
 * (`settings.extensionSettings.azure-devops`, what the settings page writes); then the global
 * bag; and finally whatever `az devops configure` holds, reached through `azFor` when this
 * answers empty.
 */

export type AzureSite = { organization: string; project: string };

/** A workspace's own azure-devops bag, as much of it as these reads need. */
type WorkspaceSource = {
  settings?: { extensionSettings?: Record<string, Record<string, string | string[]>> };
};

/**
 * Azure DevOps for this workspace: the declared environment variables first, then the
 * per-workspace bag, then the global one. Empty answers are what `azFor` falls back from to
 * `az devops configure`.
 */
// Pure and synchronous: nothing for an Effect to wrap.
export function azureOf(workspace: WorkspaceSource, settings: Config): AzureSite {
  const own = workspace.settings?.extensionSettings?.["azure-devops"];
  const global = settings.extensionSettings?.["azure-devops"];
  const at = (variable: string, key: string): string =>
    resolveSetting({
      env: variable,
      workspace: bagString(own, key),
      global: bagString(global, key),
      fallback: "",
    });
  return {
    organization: at(AZURE_ENV.organization, "organization"),
    project: at(AZURE_ENV.project, "project"),
  };
}

/** The organisation and project every workspace falls back to: the global settings bag, then
 * its declared environment variables, then whatever `az devops configure` holds (azDefaults
 * below). */
const globalAzure = (settings: Config): AzureSite => azureOf({}, settings);

/** Organisation and project default to whatever `az devops configure` already holds, so the
 * Azure CLI stays the single place this is configured. Shared per process through the cache,
 * keyed without a workspace: every workspace falls back to the same CLI configuration. Tests
 * reset it with `clearCache`, like every other cached answer. */

/** The Result-branching contract: the one failure `Shell` can raise here is a timeout, which
 * surfaces as a failed command (exit code 124) rather than a failure of the operation, so
 * everything downstream branches on `code`. */
const shResult = (cmd: string[]): Effect.Effect<{ code: number; stdout: string }, never, Shell | Workspace> =>
  Effect.gen(function* () {
    const shell = yield* Shell;
    return yield* shell.run(cmd).pipe(
      Effect.catchAll((e) => Effect.succeed({ code: e.exitCode, stdout: "", stderr: e.stderr })),
    );
  });

export const azDefaults = (): Effect.Effect<
  { organization?: string; project?: string },
  never,
  Shell | Workspace | Cache | Settings
> =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    return yield* cache.swr("az:defaults", 5 * 60_000, loadDefaults());
  });

const loadDefaults = (): Effect.Effect<
  { organization?: string; project?: string },
  never,
  Shell | Workspace | Settings
> =>
  Effect.gen(function* () {
    const r = yield* shResult(["az", "devops", "configure", "-l"]);
    const read = (key: string): string | undefined =>
      new RegExp(`^${key}\\s*=\\s*(\\S+)`, "m").exec(r.stdout)?.[1];
    const global = globalAzure(yield* Settings);
    // The configuration chain's end: the azure-devops settings (environment variable, then the
    // bag), then what the CLI itself holds.
    return {
      organization: global.organization || read("organization"),
      project: global.project || read("project"),
    };
  });

/**
 * Which Azure DevOps this workspace means, and how to say so on a command line.
 *
 * `az` has one configured default organisation and project, which is fine until a second client
 * turns up. A workspace that names its own gets them passed explicitly; one that does not falls
 * back to `az devops configure`.
 *
 * The key namespaces the cache: two organisations answering the same question differently is
 * exactly the bug this prevents.
 */
export type Az = { key: string; args: string[]; organization?: string; project?: string };

export const azFor = (
  workspace: { id: string; settings?: { extensionSettings?: Record<string, Record<string, string | string[]>> }; azure?: unknown },
): Effect.Effect<Az, never, Shell | Workspace | Cache | Settings> =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const own = azureOf(workspace, settings);
    const fallback = yield* azDefaults();
    const organization = own.organization || fallback.organization;
    const project = own.project || fallback.project;
    return {
      key: workspace.id,
      args: [
        ...(organization ? ["--organization", organization] : []),
        ...(project ? ["--project", project] : []),
      ],
      organization,
      project,
    };
  });
