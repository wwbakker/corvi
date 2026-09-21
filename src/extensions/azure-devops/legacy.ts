import type { Config } from "@corvi/configuration/config";
import { env } from "../../capabilities/identity.ts";
import { readFileSync } from "../../workspace/server/config.ts";
import { resolveSetting } from "@corvi/configuration/settings";

/** The config file as written, for the legacy flat fields `load()` deletes after spreading.
 * Undefined when the file cannot be read: the chain then falls back to the bag and the
 * environment alone. */
const readLegacyFile = (): Record<string, unknown> | undefined => {
  try {
    return readFileSync() as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/**
 * The azure-devops extension's raw reads of the fields the core used to own.
 *
 * The core no longer types or writes them, but every file boundary decodes with unknown keys
 * preserved, so a config.json or a workspace entry written before the `azure-devops` extension
 * existed still carries them at runtime. These are the one place the extension names them, and
 * the one narrow cast each read needs; nothing else in the extension — and nothing in the
 * core — reaches for a legacy field.
 */

/** The environment variables the extension's declared settings name, so the settings page's
 * lock and the fallback here cannot drift apart. */
export const AZURE_ENV = {
  organization: env("AZURE_ORG"),
  project: env("AZURE_PROJECT"),
  environments: env("AZURE_ENVIRONMENTS"),
} as const;

/** The legacy `azure: false` fact, or the per-workspace organisation/project overrides, when
 * the workspace carries them: absent or a non-object means the workspace declares nothing of
 * its own. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacyWorkspaceOf = (workspace: object): {
  disabled?: boolean;
  organization?: string;
  project?: string;
} => {
  const value = (workspace as { azure?: unknown }).azure;
  if (value === false) return { disabled: true };
  if (typeof value !== "object" || value === null) return {};
  const site = value as { organization?: unknown; project?: unknown };
  const str = (field: unknown): string | undefined =>
    typeof field === "string" && field.trim() ? field : undefined;
  return { organization: str(site.organization), project: str(site.project) };
};

/** The legacy flat organisation/project settings, as the config file still holds them. The
 * environment variable beats the file, exactly as the resolved chain did before the fields
 * left the core. Read from the file, not the resolved config: `load()` deletes the retired
 * keys after spreading, so they are only visible where they were written. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacyOrgProjectOf = (config: Config): { organization: string; project: string } => {
  const legacy = (readLegacyFile() ?? config) as Config & {
    azureOrganization?: string;
    azureProject?: string;
  };
  return {
    organization: resolveSetting({
      env: AZURE_ENV.organization,
      file: legacy.azureOrganization,
      fallback: "",
    }),
    project: resolveSetting({
      env: AZURE_ENV.project,
      file: legacy.azureProject,
      fallback: "",
    }),
  };
};

/** The legacy flat deployment conventions, as the config file still holds them: read from the
 * file, like the organisation and project above. */
// Pure and synchronous: nothing for an Effect to wrap.
export const legacyDeployOf = (config: Config): {
  pipeline?: readonly [string, string];
  versionParameter?: string;
  environmentParameter?: string;
  environments?: string[];
} => {
  void config;
  const legacy = (readLegacyFile() ?? {}) as {
    azureDeploy?: {
      pipeline?: readonly [string, string];
      versionParameter?: string;
      environmentParameter?: string;
      environments?: string[];
    };
  };
  const parseEnvironments = (raw: string): string[] | undefined =>
    raw === ""
      ? undefined
      : raw
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
  return {
    pipeline: legacy.azureDeploy?.pipeline,
    versionParameter: legacy.azureDeploy?.versionParameter,
    environmentParameter: legacy.azureDeploy?.environmentParameter,
    environments: resolveSetting({
      env: AZURE_ENV.environments,
      file: legacy.azureDeploy?.environments,
      fallback: undefined,
      parse: parseEnvironments,
    }),
  };
};
