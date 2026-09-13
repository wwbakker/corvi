import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearCache } from "../src/capabilities/cache.ts";
import { config, reloadConfigSync } from "../src/workspace/server/index.ts";
import azureDevops from "../src/extensions/azure-devops/index.ts";
import { acceptedVersions, type Run } from "../src/extensions/azure-devops/server.ts";
import { deploySettingsOf } from "../src/extensions/azure-devops/deploySettings.ts";
import { runVersionsFor } from "./helpers.ts";
import { autoDeployedApp } from "../src/extensions/azure-devops/deployConventions.ts";
import type { Az } from "../src/extensions/azure-devops/azure.ts";

// `acceptedVersions` is pure and synchronous on purpose: the one thing that would otherwise need
// `az` — the expected duration — is computed by the caller and handed in, so every case here
// runs on plain arrays, no CLI in reach and nothing to mock.
// The last test answers through the live config, so the file and the cache are restored after
// every test: one file's answers must never leak into another's.
beforeEach(() => clearCache());
afterEach(() => {
  config.extensionSettings = undefined;
  reloadConfigSync();
  clearCache();
});
const az: Az = { key: "test", args: [], organization: "org", project: "proj" };

const run = (
  id: number,
  version: string,
  environment = "accept",
  status = "completed",
  result: string | null = "succeeded",
): Run => ({
  id,
  buildNumber: `run-${id}`,
  status,
  result,
  sourceBranch: "refs/heads/main",
  startTime: "2026-09-01T09:00:00Z",
  finishTime: status === "completed" ? "2026-09-01T09:10:00Z" : null,
  templateParameters: { environment, imageTag: version },
});

test("the extension declares the settings the settings page renders", () => {
  // Organisation and project are declared twice over: as a server-wide setting and as a
  // per-workspace override, which is the chain the shared azure client reads.
  expect(azureDevops.workspaceSettings?.map((f) => f.key)).toEqual(["organization", "project"]);
  expect(azureDevops.globalSettings?.map((f) => f.key)).toEqual([
    "organization",
    "project",
    "pipeline",
    "versionParameter",
    "environmentParameter",
    "environments",
  ]);
});

test("*-app deploys are read from the deploy run's own parameters, newest first", () => {
  const runs = [run(1, "v1"), run(3, "v3"), run(2, "v2")];
  const entries = acceptedVersions(runs, az, deploySettingsOf(undefined, {}), undefined, 5);
  expect(entries.map((e) => e.version)).toEqual(["v3", "v2", "v1"]);
  // Where it already is: the one environment this lookup ever sees is the one it filtered to.
  expect(entries[0]).toMatchObject({ deployedTo: ["accept"], running: false });
  expect(entries[0]!.url).toBe("org/proj/_build/results?buildId=3");
});

test("a version is listed once even when several runs produced it", () => {
  const entries = acceptedVersions([run(2, "v1"), run(1, "v1")], az, deploySettingsOf(undefined, {}), undefined, 5);
  expect(entries).toHaveLength(1);
  // The newest of the repeats wins, not the oldest.
  expect(entries[0]!.runId).toBe(2);
});

test("howMany caps the list, same as the build-scraped path", () => {
  const runs = [run(3, "v3"), run(2, "v2"), run(1, "v1")];
  expect(acceptedVersions(runs, az, deploySettingsOf(undefined, {}), undefined, 2).map((e) => e.version)).toEqual(["v3", "v2"]);
});

test("a run to another environment is not mistaken for an accept deploy", () => {
  const entries = acceptedVersions([run(1, "v1", "production")], az, deploySettingsOf(undefined, {}), undefined, 5);
  expect(entries).toEqual([]);
});

test("a run without a recognisable version is skipped, not shown as blank", () => {
  const nothingToGoOn: Run = {
    ...run(1, "unused"),
    templateParameters: { environment: "accept", a: "1", b: "2" },
  };
  expect(acceptedVersions([nothingToGoOn], az, deploySettingsOf(undefined, {}), undefined, 5)).toEqual([]);
});

test("a still-deploying run shows its real version and a progress bar, not a placeholder", () => {
  const deploying = run(4, "v4", "accept", "inProgress", null);
  const entries = acceptedVersions([deploying, run(3, "v3")], az, deploySettingsOf(undefined, {}), 12 * 60_000, 5);
  const found = entries.find((e) => e.version === "v4");
  expect(found).toMatchObject({
    running: true,
    startedAt: "2026-09-01T09:00:00Z",
    expectedMs: 12 * 60_000,
  });
  // Finished entries do not carry the expected duration of somebody else's run.
  expect(entries.find((e) => e.version === "v3")).toMatchObject({
    running: false,
    expectedMs: undefined,
  });
});

test("the *-app suffix is the whole rule, and it is shared with the page that hides the button", () => {
  expect(autoDeployedApp("example-app")).toBe(true);
  expect(autoDeployedApp("example-legacy-app")).toBe(true);
  expect(autoDeployedApp("example-service")).toBe(false);
});

test("an *-app service with no deploy pipeline at all returns nothing to offer, not an error", async () => {
  // No CLI in reach makes this the same call the dashboard makes for a service nobody has heard
  // of: `deployPipelineName` will not match a real pipeline whatever `az` says, so this stays a
  // behavioural check rather than one that depends on the local machine's Azure DevOps login.
  await expect(runVersionsFor("definitely-not-a-real-service-app")).resolves.toEqual([]);
});
