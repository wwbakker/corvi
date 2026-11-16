import { test, expect, afterEach, beforeEach } from "bun:test";
import { clearCache } from "../apps/server/src/capabilities/cache.ts";
import { azureOf } from "@corvi/azure-devops/azure";
import { deploySettings, deploySettingsOf } from "@corvi/azure-devops/deploySettings";
import {
  runtimeConfig,
  extensionEnabled,
  reloadConfigSync,
  type Workspace,
} from "../apps/server/src/workspace/server/index.ts";
import { runEffect, withRuntimeConfig, withEnv } from "./helpers.ts";

/**
 * The azure-devops extension's settings chain, read live from the one config object. The tests
 * mutate that object and put it back, because it is shared by every module.
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
  expect(extensionEnabled(ws({ settings: { extensions: [] } }), "anything")).toBe(false);
  expect(extensionEnabled(ws({ settings: { extensions: ["github"] } }), "github")).toBe(true);
  expect(extensionEnabled(ws({ settings: { extensions: ["github"] } }), "jira")).toBe(false);
});

test("azureOf walks the chain one level at a time", () => {
  return withEnv({ CORVI_AZURE_ORG: undefined, CORVI_AZURE_PROJECT: undefined }, () => {
    runtimeConfig().extensionSettings = {
      "azure-devops": { organization: "global-org", project: "global-proj" },
    };

    // The global settings bag is the first level that answers when the workspace says nothing.
    expect(azureOf(ws(), runtimeConfig())).toEqual({ organization: "global-org", project: "global-proj" });

    // The workspace's own bag — what the settings page writes — sits above it.
    expect(
      azureOf(
        ws({
          settings: {
            extensionSettings: { "azure-devops": { organization: "own-org", project: "own-proj" } },
          },
        }),
        runtimeConfig(),
      ),
    ).toEqual({ organization: "own-org", project: "own-proj" });
    // Half a per-workspace address still leaves the other half to the level below.
    expect(
      azureOf(
        ws({ settings: { extensionSettings: { "azure-devops": { project: "own-proj" } } } }),
        runtimeConfig(),
      ),
    ).toEqual({ organization: "global-org", project: "own-proj" });

    // With no bag at all, the empty answer is what `azFor` falls back from to `az devops configure`.
    runtimeConfig().extensionSettings = {};
    expect(azureOf(ws(), runtimeConfig())).toEqual({ organization: "", project: "" });
  });
});

test("a declared environment variable beats the bags at every scope", () => {
  return withEnv({ CORVI_AZURE_ORG: "https://dev.azure.com/from-env" }, () => {
    runtimeConfig().extensionSettings = {
      "azure-devops": { organization: "global-org" },
    };
    // The machine talks at every scope: the settings page shows the field locked, and the
    // chain reads the variable before either bag.
    expect(
      azureOf(
        ws({ settings: { extensionSettings: { "azure-devops": { organization: "own-org" } } } }),
        runtimeConfig(),
      ).organization,
    ).toBe("https://dev.azure.com/from-env");
    expect(azureOf(ws(), runtimeConfig()).organization).toBe("https://dev.azure.com/from-env");
  });
});

test("deploySettingsOf reads the declared environment variable, then the bags, then the default", () => {
  return withEnv({ CORVI_AZURE_ENVIRONMENTS: undefined }, () => {
    expect(deploySettingsOf({ environments: ["dev", "accept"] })).toMatchObject({
      environments: ["dev", "accept"],
    });
    // The declared variable wins at every scope, including over a bag that speaks.
    process.env.CORVI_AZURE_ENVIRONMENTS = "accept , production";
    expect(deploySettingsOf({ environments: ["own"] }, { environments: ["global"] })).toMatchObject({
      environments: ["accept", "production"],
    });
    expect(deploySettingsOf(undefined)).toMatchObject({
      environments: ["accept", "production"],
    });
    delete process.env.CORVI_AZURE_ENVIRONMENTS;
    // The workspace's bag over the global one, field by field.
    expect(deploySettingsOf(undefined, { environments: ["global"] })).toMatchObject({
      environments: ["global"],
    });
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
  });
});

test("deploySettings reads the extension's own bag through the Settings capability", async () => {
  await withRuntimeConfig(
    { extensionSettings: { "azure-devops": { environments: ["dev", "accept"] } } },
    async () => {
      expect((await runEffect(deploySettings())).environments).toEqual(["dev", "accept"]);
    },
  );
});
