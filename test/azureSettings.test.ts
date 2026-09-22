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
import { runEffect, withRuntimeConfig } from "./helpers.ts";
// The app sets the config's workspace migrator when its integration list is composed; importing
// the composition root makes the legacy per-workspace `azure` objects fold as they do in production.
import "../apps/server/src/integrations/index.ts";

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
  const previousOrg = process.env.CORVI_AZURE_ORG;
  const previousProject = process.env.CORVI_AZURE_PROJECT;
  delete process.env.CORVI_AZURE_ORG;
  delete process.env.CORVI_AZURE_PROJECT;
  try {
    runtimeConfig().extensionSettings = {
      "azure-devops": { organization: "global-org", project: "global-proj" },
    };

    // The global settings bag is the first level that answers when the workspace says nothing.
    expect(azureOf(ws(), runtimeConfig())).toEqual({ organization: "global-org", project: "global-proj" });

    // The per-workspace settings bag — what the settings page writes — sits above it.
    expect(
      azureOf(
        ws({ extensionSettings: { "azure-devops": { organization: "own-org", project: "own-proj" } } }),
        runtimeConfig(),
      ),
    ).toEqual({ organization: "own-org", project: "own-proj" });
    // Half a per-workspace address still leaves the other half to the level below.
    expect(
      azureOf(ws({ extensionSettings: { "azure-devops": { project: "own-proj" } } }), runtimeConfig()),
    ).toEqual({ organization: "global-org", project: "own-proj" });

    // With no bag at all, the empty answer is what `azFor` falls back from to `az devops configure`.
    runtimeConfig().extensionSettings = {};
    expect(azureOf(ws(), runtimeConfig())).toEqual({ organization: "", project: "" });
  } finally {
    if (previousOrg === undefined) delete process.env.CORVI_AZURE_ORG;
    else process.env.CORVI_AZURE_ORG = previousOrg;
    if (previousProject === undefined) delete process.env.CORVI_AZURE_PROJECT;
    else process.env.CORVI_AZURE_PROJECT = previousProject;
  }
});

test("deploySettingsOf reads the bag, then the declared environment variable, then the default", () => {
  const previous = process.env.CORVI_AZURE_ENVIRONMENTS;
  delete process.env.CORVI_AZURE_ENVIRONMENTS;
  try {
    expect(deploySettingsOf({ environments: ["dev", "accept"] })).toMatchObject({
      environments: ["dev", "accept"],
    });
    process.env.CORVI_AZURE_ENVIRONMENTS = "accept , production";
    expect(deploySettingsOf(undefined)).toMatchObject({
      environments: ["accept", "production"],
    });
    delete process.env.CORVI_AZURE_ENVIRONMENTS;
    // A bag list that is not two names is not set: the default answers whole.
    expect(deploySettingsOf({ pipeline: ["only-one"] })).toMatchObject({
      pipeline: ["build-", "deploy-"],
    });
    expect(deploySettingsOf(undefined)).toMatchObject({
      pipeline: ["build-", "deploy-"],
      versionParameter: "dockerTag",
      environmentParameter: "environment",
      environments: ["accept", "production"],
    });
  } finally {
    if (previous === undefined) delete process.env.CORVI_AZURE_ENVIRONMENTS;
    else process.env.CORVI_AZURE_ENVIRONMENTS = previous;
  }
});

test("deploySettings reads the extension's own bag through the Settings capability", async () => {
  await withRuntimeConfig(
    { extensionSettings: { "azure-devops": { environments: ["dev", "accept"] } } },
    async () => {
      expect((await runEffect(deploySettings())).environments).toEqual(["dev", "accept"]);
    },
  );
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

    // The flat fields and the deployment conventions resolve from a legacy-only file: the loader
    // folds them into the extension's global bag and the resolved config no longer carries them.
    expect(azureOf(ws(), runtimeConfig()).organization).toBe("https://dev.azure.com/legacy");
    expect("azureOrganization" in runtimeConfig()).toBe(false);
    expect("azureProject" in runtimeConfig()).toBe(false);
    expect("azureDeploy" in runtimeConfig()).toBe(false);
    expect((await runEffect(deploySettings())).environments).toEqual(["accept", "production"]);

    // The legacy per-workspace object still wins for project; the flat field answers organisation.
    const client = runtimeConfig().workspaces[0]!;
    expect(azureOf(client, runtimeConfig())).toEqual({
      organization: "https://dev.azure.com/legacy",
      project: "PerWorkspace",
    });

    // The environment variable answers when the bag is empty, and the bag beats it once the
    // page has written a value.
    runtimeConfig().extensionSettings = {};
    process.env.CORVI_AZURE_ORG = "https://dev.azure.com/from-env";
    expect(azureOf(runtimeConfig().workspaces[0]!, runtimeConfig()).organization).toBe(
      "https://dev.azure.com/from-env",
    );
    runtimeConfig().extensionSettings = { "azure-devops": { organization: "global-org" } };
    expect(azureOf(runtimeConfig().workspaces[0]!, runtimeConfig()).organization).toBe("global-org");
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
