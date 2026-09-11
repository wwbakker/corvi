import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azureEnabled, azureOf } from "../src/core/integrations/azure.ts";
import { deploySettings } from "../src/extensions/deployments/deploySettings.ts";
import {
  config,
  extensionEnabled,
  reloadConfigSync,
  type Workspace,
} from "../src/workspace/server/index.ts";

/**
 * The azure client's settings chain and its enablement rule, both read live from the one config
 * object. The tests mutate that object and put it back, because it is shared by every module.
 */
const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "t", name: "T", ...patch });

const original = {
  extensionSettings: config.extensionSettings,
  azureOrganization: config.azureOrganization,
  azureProject: config.azureProject,
};

afterEach(() => {
  config.extensionSettings = original.extensionSettings;
  config.azureOrganization = original.azureOrganization;
  config.azureProject = original.azureProject;
});

test("extensionEnabled is the one enablement rule: an absent list means all of them", () => {
  expect(extensionEnabled(ws(), "anything")).toBe(true);
  expect(extensionEnabled(ws({ extensions: [] }), "anything")).toBe(false);
  expect(extensionEnabled(ws({ extensions: ["ci"] }), "ci")).toBe(true);
  expect(extensionEnabled(ws({ extensions: ["ci"] }), "jira")).toBe(false);
});

test("azureEnabled is the deployments extension's enablement plus the legacy flag", () => {
  // A workspace that names no extensions has deployments, unless it said `azure: false`.
  expect(azureEnabled(ws())).toBe(true);
  expect(azureEnabled(ws({ azure: false }))).toBe(false);
  // Naming a list is the whole list: without deployments there are no pipelines.
  expect(azureEnabled(ws({ extensions: ["ci", "git"] }))).toBe(false);
  expect(azureEnabled(ws({ extensions: ["ci", "deployments"] }))).toBe(true);
  // The legacy fact still wins over a listed deployments.
  expect(azureEnabled(ws({ extensions: ["deployments"], azure: false }))).toBe(false);
});

test("azureOf walks the chain one level at a time", () => {
  config.azureOrganization = "flat-org";
  config.azureProject = "flat-proj";
  config.extensionSettings = {
    deployments: { organization: "global-org", project: "global-proj" },
  };

  // The global settings bag is the first level that answers when the workspace says nothing.
  expect(azureOf(ws())).toEqual({ organization: "global-org", project: "global-proj" });

  // The legacy per-workspace object sits above it.
  expect(azureOf(ws({ azure: { organization: "legacy-org", project: "legacy-proj" } }))).toEqual({
    organization: "legacy-org",
    project: "legacy-proj",
  });
  // Half a legacy address still leaves the other half to the level below.
  expect(azureOf(ws({ azure: { project: "legacy-proj" } }))).toEqual({
    organization: "global-org",
    project: "legacy-proj",
  });

  // The per-workspace settings bag — what the settings page writes — sits above both.
  expect(
    azureOf(
      ws({
        azure: { organization: "legacy-org", project: "legacy-proj" },
        extensionSettings: { deployments: { organization: "own-org", project: "own-proj" } },
      }),
    ),
  ).toEqual({ organization: "own-org", project: "own-proj" });

  // With the global bag empty, the legacy flat field answers; with nothing at all, the empty
  // answer is what `azFor` falls back from to `az devops configure`.
  config.extensionSettings = {};
  expect(azureOf(ws())).toEqual({ organization: "flat-org", project: "flat-proj" });
  config.azureOrganization = "";
  config.azureProject = "";
  expect(azureOf(ws())).toEqual({ organization: "", project: "" });
});

test("a config file with only the legacy fields still works", async () => {
  const originalConfig = process.env.IWE_CONFIG;
  const originalOrg = process.env.IWE_AZURE_ORG;
  const originalProject = process.env.IWE_AZURE_PROJECT;
  const dir = await mkdtemp(join(tmpdir(), "iwe-azure-legacy-"));
  process.env.IWE_CONFIG = join(dir, "config.json");
  delete process.env.IWE_AZURE_ORG;
  delete process.env.IWE_AZURE_PROJECT;
  try {
    await Bun.write(
      process.env.IWE_CONFIG,
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

    // The flat fields and the deployment conventions still resolve from a legacy-only file.
    expect(config.azureOrganization).toBe("https://dev.azure.com/legacy");
    expect(config.azureProject).toBe("LegacyProj");
    expect(deploySettings().pipeline).toEqual(["build-", "deploy-"]);
    expect(deploySettings().environments).toEqual(["accept", "production"]);

    // The legacy per-workspace object still wins for project; the flat field answers organisation.
    const client = config.workspaces[0]!;
    expect(azureOf(client)).toEqual({
      organization: "https://dev.azure.com/legacy",
      project: "PerWorkspace",
    });

    // The flat field carries the environment resolution, and the global bag still beats it.
    process.env.IWE_AZURE_ORG = "https://dev.azure.com/from-env";
    reloadConfigSync();
    expect(azureOf(config.workspaces[0]!).organization).toBe("https://dev.azure.com/from-env");
    config.extensionSettings = { deployments: { organization: "global-org" } };
    expect(azureOf(config.workspaces[0]!).organization).toBe("global-org");
  } finally {
    if (originalConfig === undefined) delete process.env.IWE_CONFIG;
    else process.env.IWE_CONFIG = originalConfig;
    if (originalOrg === undefined) delete process.env.IWE_AZURE_ORG;
    else process.env.IWE_AZURE_ORG = originalOrg;
    if (originalProject === undefined) delete process.env.IWE_AZURE_PROJECT;
    else process.env.IWE_AZURE_PROJECT = originalProject;
    await rm(dir, { recursive: true, force: true });
    reloadConfigSync();
  }
});
