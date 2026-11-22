/** The harness server wiring against isolated config and state: the files, the resolved views,
 * the change's selectors, regeneration on save, and cleanup. */
import { afterAll, expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Change } from "@corvi/changes/record";
import { corviExtensionDir } from "@corvi/agents/node";
import { stateDir } from "@corvi/configuration/node";
import { applyPatch } from "../apps/server/src/change/model.ts";
import { removeHarnessState } from "../apps/server/src/harnesses/server/cleanup.ts";
import {
  harnessLaunchByKey,
  harnessWindowCommand,
  openHarnessWindow,
  subagentHarnessLaunch,
  userHarnessLaunch,
} from "../apps/server/src/harnesses/server/env.ts";
import { harnessChoices } from "../apps/server/src/harnesses/server/choices.ts";
import {
  deleteHarnessFile,
  harnessFiles,
  writeHarnessFile,
} from "../apps/server/src/harnesses/server/files.ts";
import {
  harnessDiscoveryFor,
  resolveSubagentHarness,
  selectedHarnessKey,
} from "../apps/server/src/harnesses/server/selection.ts";
import { harnessListFor } from "../apps/server/src/harnesses/server/views.ts";

const harnessesListWithViews = (change: Change, views: boolean): ReturnType<typeof harnessListFor> =>
  harnessListFor(change, { views });
import {
  configPath,
  reloadConfigSync,
  settingsOf as readEffective,
  workspaceOf,
} from "../apps/server/src/workspace/server/index.ts";
import { changeDir } from "../apps/server/src/change/server/index.ts";
import { createInstance, type SubagentRecord } from "@corvi/agents/node";
import { runEffect, runSh, testTempDir } from "./helpers.ts";

/** These tests set the process's config and agent directories: the file that runs after this one
 * must see whatever it had before, not a removed temp dir. */
const previousConfig = process.env.CORVI_CONFIG;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const own = await testTempDir("harnesses");
const changesRoot = join(own, "changes");
const agentDir = join(own, "agent");
process.env.CORVI_CONFIG = join(own, "config.json");
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "extensions", "footer"), { recursive: true });
await mkdir(join(agentDir, "skills", "spiega"), { recursive: true });
await writeFile(join(agentDir, "extensions", "footer", "index.ts"), "export {};\n");
await writeFile(join(agentDir, "skills", "spiega", "SKILL.md"), "# spiega\n");
await writeFile(join(agentDir, "settings.json"), "{}\n");
await writeFile(
  configPath(),
  `${JSON.stringify(
    {
      changesRoot,
      harnessDefaults: { user: "global:review-env", subagents: "global:review-env" },
    },
    null,
    2,
  )}\n`,
);

const CHANGE_ID = "harness-change";
const ownerDir = (): string => dirname(configPath());
const change = {
  id: CHANGE_ID,
  branch: CHANGE_ID,
  checkouts: [],
  workspace: "default",
  state: "Implementation",
  createdAt: "2026-01-01T00:00:00.000Z",
} as Change;

await mkdir(join(own, "harnesses"), { recursive: true });

/** The change on disk, so the file API's regeneration can find it. The effective changes root is
 * the isolated one (the environment wins over the file), not the path in this test's config. */
const writeChangeRecord = async (): Promise<void> => {
  const root = readEffective(workspaceOf(change)).changesRoot;
  await mkdir(join(root, CHANGE_ID), { recursive: true });
  await writeFile(
    join(root, CHANGE_ID, "change.json"),
    `${JSON.stringify(
      {
        id: CHANGE_ID,
        branch: CHANGE_ID,
        workspace: "default",
        state: "Implementation",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
};

const reviewHarness = (extra: string): string =>
  ["---", "label: Review environment", "harness: pi-bare", extra, "---", "notes"]
    .filter((line) => line !== "")
    .join("\n");

const readSettings = async (dir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;

test("the file API lists the built-ins and round-trips a harness file", async () => {
  const listed = await runEffect(harnessFiles());
  expect(
    listed.files
      .filter((file) => file.scope === "builtin")
      .map((file) => file.id)
      .sort(),
  ).toEqual(["opencode", "pi", "pi-bare"]);

  const written = await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "review-env",
      text: reviewHarness("skills: { mode: none }"),
    }),
  );
  const found = written.files.find((file) => file.id === "review-env");
  expect(found?.label).toBe("Review environment");
  expect(found?.scope).toBe("global");

  const gone = await runEffect(deleteHarnessFile({ scope: "global", id: "review-env" }));
  expect(gone.files.find((file) => file.id === "review-env")).toBeUndefined();
});

test("the resolved list shows the chain, sections, warnings and the change's selection", async () => {
  reloadConfigSync();
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "review-env",
      text: reviewHarness("skills: { mode: none, include: [spiega] }"),
    }),
  );
  const listed = await runEffect(harnessListFor(change));
  expect(listed.selection).toEqual({
    userDefault: "global:review-env",
    subagentDefault: "global:review-env",
  });
  const found = listed.harnesses.find((harness) => harness.key === "global:review-env");
  expect(found?.problem).toBeUndefined();
  expect(found?.view?.chain.map((link) => link.id)).toEqual(["review-env", "pi-bare", "pi"]);
  expect(found?.view?.generatedDir).toBe(join(stateDir(), "harnesses", CHANGE_ID, "global", "review-env"));
  expect(found?.view?.sections.extensions.items.find((item) => item.byCorvi === true)?.state).toBe(
    "included",
  );
  expect(found?.view?.sections.skills.items.find((item) => item.name === "spiega")?.state).toBe("included");
  expect(found?.view?.sections.skills.items.find((item) => item.name === "spiega")?.location).toBe("skills");
});

test("saving a harness file regenerates the environment the change selected", async () => {
  reloadConfigSync();
  await writeChangeRecord();
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "review-env",
      text: reviewHarness("extensions: { mode: none }"),
    }),
  );
  expect(selectedHarnessKey(change, "user")).toBe("global:review-env");
  const first = await runEffect(userHarnessLaunch(change));
  if (first.dir === undefined) throw new Error("expected a generated Pi environment");
  expect((await readSettings(first.dir))["extensions"]).toEqual([corviExtensionDir()]);

  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "review-env",
      text: reviewHarness("extensions: { mode: none, include: [footer] }"),
    }),
  );
  const regenerated = await readSettings(first.dir);
  // The save regenerated the directory the launch had used: the included base extension is now
  // listed, with Corvi's own extension after it.
  expect(regenerated["extensions"]).toEqual([join(agentDir, "extensions", "footer"), corviExtensionDir()]);
});

test("a harness key that disappeared is a clear refusal", async () => {
  const missing = { ...change, userHarness: "global:gone" } as Change;
  await expect(runEffect(userHarnessLaunch(missing))).rejects.toThrow(/global:gone/);
});

test("a subagent's pinned harness wins, and a pin that disappeared names itself", async () => {
  const discovery = await runEffect(harnessDiscoveryFor(change));
  const pinned = resolveSubagentHarness(discovery, { pinnedKey: "builtin:pi-bare", profileHarness: "pi" });
  expect("success" in pinned && pinned.success.key).toBe("builtin:pi-bare");

  const gone = resolveSubagentHarness(discovery, { pinnedKey: "global:gone" });
  expect("failure" in gone && gone.failure.kind).toBe("unknown-harness");
});

test("the change's selectors are patched and cleared", () => {
  const patched = applyPatch(change, {
    userHarness: "global:review-env",
    subagentHarness: "repository:orders/api:worker",
  });
  expect(patched.userHarness).toBe("global:review-env");
  expect(patched.subagentHarness).toBe("repository:orders/api:worker");

  const cleared = applyPatch(patched, { userHarness: null, subagentHarness: "" });
  expect(cleared.userHarness).toBeUndefined();
  expect(cleared.subagentHarness).toBeUndefined();

  // Leaving a selector out of a patch leaves it alone.
  expect(applyPatch(patched, { title: "Renamed" }).userHarness).toBe("global:review-env");
});

test("a workspace default applies only to changes in that workspace", async () => {
  reloadConfigSync();
  const before = await readFile(configPath(), "utf8");
  await writeFile(
    configPath(),
    `${JSON.stringify(
      {
        changesRoot,
        harnessDefaults: { user: "builtin:pi" },
        workspaces: [
          {
            id: "other",
            name: "Other",
            settings: { harnessDefaults: { user: "global:review-env" } },
          },
          { id: "default", name: "Default" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  reloadConfigSync();
  try {
    const elsewhere = { ...change, workspace: "default" } as Change;
    expect(selectedHarnessKey(elsewhere, "user")).toBe("builtin:pi");
    const there = { ...change, workspace: "other" } as Change;
    expect(selectedHarnessKey(there, "user")).toBe("global:review-env");
  } finally {
    await writeFile(configPath(), before);
    reloadConfigSync();
  }
});

test("saving a harness regenerates a harness a dialog window opened but the change did not select", async () => {
  reloadConfigSync();
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "dialog-env",
      text: reviewHarness("extensions: { mode: none }"),
    }),
  );
  const opened = await runEffect(harnessLaunchByKey(change, "global:dialog-env"));
  if (opened.dir === undefined) throw new Error("expected a generated environment");
  expect((await readSettings(opened.dir))["extensions"]).toEqual([corviExtensionDir()]);

  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "dialog-env",
      text: reviewHarness("extensions: { mode: none, include: [footer] }"),
    }),
  );
  expect((await readSettings(opened.dir))["extensions"]).toEqual([
    join(agentDir, "extensions", "footer"),
    corviExtensionDir(),
  ]);
});

test("the wizard's choices include a chosen repository's harnesses, and summaries skip views", async () => {
  const repo = join(own, "orders-api");
  await mkdir(join(repo, ".corvi", "harnesses"), { recursive: true });
  await writeFile(
    join(repo, ".corvi", "harnesses", "repo-env.md"),
    "---\nlabel: Repo environment\nharness: pi\n---\n",
  );
  await writeFile(
    join(repo, ".corvi", "harnesses", "loose.md"),
    "---\nlabel: Loose environment\nharness: pi\n---\n",
  );
  await runSh(["git", "init"], repo);
  await runSh(["git", "add", ".corvi/harnesses/repo-env.md"], repo);
  await runSh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "harness"], repo);
  const choices = await runEffect(harnessChoices({ repositories: [repo], trackedRepositories: [repo] }));
  expect(choices.harnesses.map((harness) => harness.key)).toContain("repository:orders-api:repo-env");
  expect(choices.harnesses.every((harness) => harness.view === undefined)).toBe(true);
  // Only the tracked file is offered: an untracked harness would be absent from a fresh worktree.
  expect(choices.harnesses.map((harness) => harness.id)).not.toContain("loose");
  // An in-place checkout resolves an untracked harness at launch, so it is offered unfiltered.
  const inPlace = await runEffect(harnessChoices({ repositories: [repo] }));
  expect(inPlace.harnesses.map((harness) => harness.id)).toContain("loose");

  reloadConfigSync();
  const listed = await runEffect(harnessesListWithViews(change, false));
  expect(listed.harnesses.every((harness) => harness.view === undefined)).toBe(true);
});

test("the harness window route translates sentinels and runs the harness's own agent", async () => {
  reloadConfigSync();
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "oc-env",
      text: "---\nlabel: Open environment\nharness: opencode\nmodel: zai/glm-5.3\n---\n",
    }),
  );
  const opened: {
    directory: string;
    command: string;
    harness?: string;
    envDir?: string;
    intent?: "activate" | "background";
  }[] = [];
  const fake = async (
    _changeId: string,
    directory: string,
    command: string,
    options: {
      readonly harness?: string;
      readonly envDir?: string;
      readonly intent?: "activate" | "background";
    },
  ): Promise<string> => {
    opened.push({ directory, command, ...options });
    return "w-test";
  };
  await runEffect(
    openHarnessWindow(change, { harness: "global:oc-env", directory: "change" }, fake as never),
  );
  expect(opened[0]?.directory).toBe(changeDir(change));
  expect(opened[0]?.envDir).toBe(changeDir(change));
  expect(opened[0]?.command).toContain("exec opencode");
  expect(opened[0]?.command).toContain("--model 'zai/glm-5.3'");
  expect(opened[0]?.harness).toBe("global:oc-env");
  expect(opened[0]?.intent).toBe("activate");

  opened.length = 0;
  await runEffect(openHarnessWindow(change, { harness: "builtin:pi", directory: "current" }, fake as never));
  expect(opened[0]?.directory).toBe(changeDir(change));
  expect(opened[0]?.command).toBe("exec pi");
});

test("a harness window runs its agent, with opencode's model", () => {
  expect(harnessWindowCommand({ agent: "pi", fields: {} as never }, undefined)).toBe("exec pi");
  const command = harnessWindowCommand(
    { agent: "opencode", fields: { model: "zai/glm-5.3" } as never },
    'harness "oc": a warning',
  );
  expect(command).toContain("exec opencode");
  expect(command).toContain("--model 'zai/glm-5.3'");
  expect(command).toContain("a warning");
});

test("save regeneration gates a subagent on its pinned harness's chain", async () => {
  reloadConfigSync();
  await writeChangeRecord();
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "gate-a",
      text: reviewHarness("extensions: { mode: none }"),
    }),
  );
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "gate-b",
      text: reviewHarness("extensions: { mode: none }"),
    }),
  );
  const record = (id: string, harnessKey: string): SubagentRecord => ({
    id,
    changeId: change.id,
    profile: "global:none",
    label: id,
    harnessKey,
    harness: "pi",
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    log: [],
  });
  const a = record("gate-sub-a", "global:gate-a");
  const b = record("gate-sub-b", "global:gate-b");
  await runEffect(createInstance(changeDir(change), a));
  await runEffect(createInstance(changeDir(change), b));

  const launchedA = await runEffect(subagentHarnessLaunch(change, a));
  const launchedB = await runEffect(subagentHarnessLaunch(change, b));
  if (launchedA.dir === undefined || launchedB.dir === undefined) {
    throw new Error("expected subagent environments");
  }
  expect((await readSettings(launchedA.dir))["extensions"]).toEqual([corviExtensionDir()]);

  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "gate-b",
      text: reviewHarness("extensions: { mode: none, include: [footer] }"),
    }),
  );
  // B's chain reaches the saved file, A's does not: only B is regenerated.
  expect((await readSettings(launchedB.dir))["extensions"]).toEqual([
    join(agentDir, "extensions", "footer"),
    corviExtensionDir(),
  ]);
  expect((await readSettings(launchedA.dir))["extensions"]).toEqual([corviExtensionDir()]);
});

test("a legacy subagent record without a pinned key is still regenerated from its profile", async () => {
  reloadConfigSync();
  await writeChangeRecord();
  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "legacy-env",
      text: reviewHarness("extensions: { mode: none }"),
    }),
  );
  await mkdir(join(ownerDir(), "subagents"), { recursive: true });
  await writeFile(
    join(ownerDir(), "subagents", "legacy-profile.md"),
    "---\nlabel: Legacy profile\nharness: legacy-env\n---\nDo it.\n",
  );
  const legacy: SubagentRecord = {
    id: "legacy-sub",
    changeId: change.id,
    profile: "global:legacy-profile",
    label: "Legacy",
    harness: "pi",
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    log: [],
  };
  await runEffect(createInstance(changeDir(change), legacy));
  const launched = await runEffect(subagentHarnessLaunch(change, legacy));
  if (launched.dir === undefined) throw new Error("expected an environment");
  expect((await readSettings(launched.dir))["extensions"]).toEqual([corviExtensionDir()]);

  await runEffect(
    writeHarnessFile({
      scope: "global",
      id: "legacy-env",
      text: reviewHarness("extensions: { mode: none, include: [footer] }"),
    }),
  );
  expect((await readSettings(launched.dir))["extensions"]).toEqual([
    join(agentDir, "extensions", "footer"),
    corviExtensionDir(),
  ]);
});

test("archiving removes the change's generated harness tree", async () => {
  reloadConfigSync();
  const launch = await runEffect(userHarnessLaunch(change));
  if (launch.dir === undefined) throw new Error("expected a generated Pi environment");
  expect((await lstat(launch.dir)).isDirectory()).toBe(true);
  await runEffect(removeHarnessState(CHANGE_ID));
  expect(await lstat(launch.dir).catch(() => undefined)).toBeUndefined();
});

afterAll(async () => {
  await rm(own, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.CORVI_CONFIG;
  else process.env.CORVI_CONFIG = previousConfig;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  reloadConfigSync();
});
