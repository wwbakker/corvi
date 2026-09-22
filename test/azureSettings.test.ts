import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCache } from "../apps/server/src/capabilities/cache.ts";
import { azureOf } from "@corvi/azure-devops/azure";
import { deploySettings, deploySettingsOf } from "@corvi/azure-devops/deploySettings";
import {
  runtimeConfig,
  extensionEnabled,
  reloadConfigSync,
  type Workspace,
} from "../apps/server/src/workspace/server/index.ts";
import { runEffect } from "./helpers.ts";

/**
 * The azure-devops extension's settings chain and the migration that folds the retired shapes
 * into it, both read live from the one config object. The tests mutate that object and put it
 * back, because it is shared by every module.
 */
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "t", name: "T", ...patch });

const originalConfig = process.env.CORVI_CONFIG;
const originalOrg = process.env.CORVI_AZURE_ORG;
const originalProject = process.env.CORVI_AZURE_PROJECT;
const originalEnvironments = process.env.CORVI_AZURE_ENVIRONMENTS;

beforeEach(() => {
  clearCache();
  runtimeConfig().extensionSettings = undefined;
});

afterEach(() => {
  runtimeConfig().extensionSettings = undefined;
  if (originalConfig === undefined) delete process.env.CORVI_CONFIG;
  else process.env.CORVI_CONFIG = originalConfig;
  if (originalOrg === undefined) delete process.env.CORVI_AZURE_ORG;
  else process.env.CORVI_AZURE_ORG = originalOrg;
  if (originalProject === undefined) delete process.env.CORVI_AZURE_PROJECT;
  else process.env.CORVI_AZURE_PROJECT = originalProject;
  if (originalEnvironments === undefined) delete process.env.CORVI_AZURE_ENVIRONMENTS;
  else process.env.CORVI_AZURE_ENVIRONMENTS = originalEnvironments;
  reloadConfigSync();
});

test("extensionEnabled is the one enablement rule: an absent list means all of them", () => {
  expect(extensionEnabled(ws(), "anything")).toBe(true);
  expect(extensionEnabled(ws({ extensions: [] }), "anything")).toBe(false);
  expect(extensionEnabled(ws({ extensions: ["github"] }), "github")).toBe(true);
  expect(extensionEnabled(ws({ extensions: ["github"] }), "jira")).toBe(false);
});

test("azureOf walks the chain one level at a time", () => {
  runtimeConfig().extensionSettings = {
    "azure-devops": { organization: "global-org", project: "global-proj" },
  };

  // The global settings bag is the first level that answers when the workspace says nothing.
  expect(azureOf(ws(), runtimeConfig())).toEqual({ organization: "global-org", project: "global-proj" });

  // The legacy per-workspace object sits above it.
  expect(
    azureOf(ws({ azure: { organization: "legacy-org", project: "legacy-proj" } } as never), runtimeConfig()),
  ).toEqual({ organization: "legacy-org", project: "legacy-proj" });
  // Half a legacy address still leaves the other half to the level below.
  expect(azureOf(ws({ azure: { project: "legacy-proj" } } as never), runtimeConfig())).toEqual({
    organization: "global-org",
    project: "legacy-proj",
  });

  // The per-workspace settings bag — what the settings page writes — sits above both.
  expect(
    azureOf(
      ws({
        azure: { organization: "legacy-org", project: "legacy-proj" },
        extensionSettings: { "azure-devops": { organization: "own-org", project: "own-proj" } },
      } as never),
      runtimeConfig(),
    ),
  ).toEqual({ organization: "own-org", project: "own-proj" });

  // With the global bag empty, the legacy flat field answers; with nothing at all, the empty
  // answer is what `azFor` falls back from to `az devops configure`.
  runtimeConfig().extensionSettings = {};
  expect(azureOf(ws(), runtimeConfig())).toEqual({ organization: "", project: "" });
});

test("deploySettingsOf reads the bag first, then the legacy flat field, then the default", () => {
  expect(
    deploySettingsOf({ environments: ["dev", "accept"] }, { environments: ["accept", "production"] }),
  ).toMatchObject({ environments: ["dev", "accept"] });
  expect(deploySettingsOf(undefined, { environments: ["accept", "production"] })).toMatchObject({
    environments: ["accept", "production"],
  });
  // A bag list that is not two names is not set: the legacy field answers whole.
  expect(
    deploySettingsOf({ pipeline: ["only-one"] }, { pipeline: ["build-", "deploy-"] as const }),
  ).toMatchObject({ pipeline: ["build-", "deploy-"] });
  expect(deploySettingsOf(undefined, {})).toMatchObject({
    pipeline: ["build-", "deploy-"],
    versionParameter: "dockerTag",
    environmentParameter: "environment",
    environments: ["accept", "production"],
  });
});

test("deploySettings reads the extension's own bag through the Settings capability", async () => {
  const before = runtimeConfig().extensionSettings;
  runtimeConfig().extensionSettings = { "azure-devops": { environments: ["dev", "accept"] } };
  try {
    expect((await runEffect(deploySettings())).environments).toEqual(["dev", "accept"]);
  } finally {
    runtimeConfig().extensionSettings = before;
  }
});

test("a config file with only the legacy fields still works", async () => {
  const originalConfig = process.env.CORVI_CONFIG;
  const originalOrg = process.env.CORVI_AZURE_ORG;
  const originalProject = process.env.CORVI_AZURE_PROJECT;
  const originalEnv = process.env.CORVI_AZURE_ENVIRONMENTS;
  const dir = await mkdtemp(join(tmpdir(), "corvi-azure-legacy-"));
  process.env.CORVI_CONFIG = join(dir, "runtimeConfig().json");
  delete process.env.CORVI_AZURE_ORG;
  delete process.env.CORVI_AZURE_PROJECT;
  delete process.env.CORVI_AZURE_ENVIRONMENTS;
  try {
    await Bun.write(
      process.env.CORVI_CONFIG,
      JSON.stringify({
        azureOrganization: "https://dev.azure.com/legacy",
        azureProject: "LegacyProj",
        azureDeploy: {
          pipeline: ["build-", "deploy-"],
          environments: ["accept", "production"],
        },
        workspaces: [{ id: "client", name: "Client", azure: { project: "PerWorkspace" } }],
      }),
    );
    reloadConfigSync();

    // The flat fields and the deployment conventions still resolve from a legacy-only file —
    // through the extension's own fallback read, not the resolved config, which no longer
    // types them.
    expect(azureOf(ws(), runtimeConfig()).organization).toBe("https://dev.azure.com/legacy");
    expect((await runEffect(deploySettings())).environments).toEqual(["accept", "production"]);

    // The legacy per-workspace object still wins for project; the flat field answers organisation.
    const client = runtimeConfig().workspaces[0]!;
    expect(azureOf(client as never, runtimeConfig())).toEqual({
      organization: "https://dev.azure.com/legacy",
      project: "PerWorkspace",
    });

    // The flat field carries the environment resolution, and the global bag still beats it.
    process.env.CORVI_AZURE_ORG = "https://dev.azure.com/from-env";
    reloadConfigSync();
    expect(azureOf(runtimeConfig().workspaces[0]! as never, runtimeConfig()).organization).toBe(
      "https://dev.azure.com/from-env",
    );
    runtimeConfig().extensionSettings = { "azure-devops": { organization: "global-org" } };
    expect(azureOf(runtimeConfig().workspaces[0]! as never, runtimeConfig()).organization).toBe("global-org");
  } finally {
    if (originalConfig === undefined) delete process.env.CORVI_CONFIG;
    else process.env.CORVI_CONFIG = originalConfig;
    if (originalOrg === undefined) delete process.env.CORVI_AZURE_ORG;
    else process.env.CORVI_AZURE_ORG = originalOrg;
    if (originalProject === undefined) delete process.env.CORVI_AZURE_PROJECT;
    else process.env.CORVI_AZURE_PROJECT = originalProject;
    if (originalEnv === undefined) delete process.env.CORVI_AZURE_ENVIRONMENTS;
    else process.env.CORVI_AZURE_ENVIRONMENTS = originalEnv;
    await rm(dir, { recursive: true, force: true });
    reloadConfigSync();
    clearCache();
  }
});
