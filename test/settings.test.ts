import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problems, settingsViewSync, writeSettings, type Settings } from "../src/settings/server/index.ts";
import { config, reloadConfigSync, type Config } from "../src/workspace/server/index.ts";
import { runEffect } from "./helpers.ts";

/**
 * The settings page writes the file the whole program reads, so the two things worth testing are
 * that a bad value never reaches it and that a good one takes effect without a restart. The
 * validation is on the server because the file is hand-editable too: rules in the browser only
 * would be rules that half the ways in ignore.
 */
let tmp: string;
let file: string;
const originalConfig = process.env.IWE_CONFIG;
// Other test files point IWE_ROOT at their own temporary directory, and the environment beats
// the file by design — with it set, a written changesRoot would correctly have no effect and
// this file would be testing the override instead.
const originalRoot = process.env.IWE_ROOT;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-settings-"));
  file = join(tmp, "config.json");
  process.env.IWE_CONFIG = file;
  delete process.env.IWE_ROOT;
  reloadConfigSync();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env.IWE_CONFIG;
  else process.env.IWE_CONFIG = originalConfig;
  if (originalRoot !== undefined) process.env.IWE_ROOT = originalRoot;
  // Other tests share this process, and a config left pointing at a deleted file is a test that
  // fails somewhere else for a reason nobody can see.
  reloadConfigSync();
});

afterEach(() => {
  delete process.env.IWE_WORKTREE_COPY;
});

test("what cannot be written", () => {
  expect(problems({ changesRoot: "changes" })).toEqual(["changesRoot must be an absolute path"]);
  // `~` is a path the program can resolve, so it is one the page may offer.
  expect(problems({ changesRoot: "~/changes" })).toEqual([]);

  expect(problems({ workspaces: [{ id: "a b", name: "Spaces" }] })).toEqual([
    'workspace id "a b" must be a word',
  ]);
  expect(
    problems({
      workspaces: [
        { id: "client", name: "Client" },
        { id: "client", name: "Twice" },
      ],
    }),
  ).toEqual(['two workspaces share the id "client"']);
  expect(problems({ workspaces: [{ id: "client", name: "" }] })).toEqual([
    'workspace "client" has no name',
  ]);

  // A directory copied into a worktree is a name next to the code, never a way out of it.
  expect(problems({ worktreeCopy: ["../.ssh"] })).toEqual([
    '"../.ssh" is not a directory name next to the code',
  ]);
  expect(problems({ worktreeCopy: [".idea", ".bsp"] })).toEqual([]);

  expect(problems({ workspaces: [{ id: "c", name: "C", env: { "not a name": "x" } }] })).toEqual([
    'C: "not a name" is not an environment variable name',
  ]);
});

test("writing takes effect without a restart, and refuses what is wrong", async () => {
  const next: Settings = {
    changesRoot: join(tmp, "changes"),
    worktreeCopy: [".idea"],
    workspaces: [
      { id: "client", name: "Client", extensionSettings: { jira: { project: "PROJ" } } },
      { id: "own", name: "My own", extensions: ["github", "git"] },
    ],
  };
  await runEffect(writeSettings(next));

  // The object every module imported, not a copy of it: that is what "no restart" means.
  expect(config.changesRoot).toBe(join(tmp, "changes"));
  expect(config.worktreeCopy).toEqual([".idea"]);
  expect(config.workspaces.map((w) => w.id)).toEqual(["client", "own"]);
  // The shapes the page wrote land on the object every module reads, untouched.
  expect(config.workspaces[0]!.extensionSettings).toEqual({ jira: { project: "PROJ" } });
  expect(config.workspaces[1]!.extensions).toEqual(["github", "git"]);

  expect(runEffect(writeSettings({ workspaces: [{ id: "", name: "Nameless" }] }))).rejects.toThrow(/no id/);
  // Refused means unchanged, not half written.
  expect(reloadConfigSync().workspaces.map((w) => w.id)).toEqual(["client", "own"]);
});

test("silencing notifications is a decision the file keeps; absent means sound", async () => {
  // The default is on, and only the decision to silence is written down, so an untouched file
  // stays a page of decisions rather than a dump of defaults.
  expect(reloadConfigSync().notificationSound).toBe(true);

  await runEffect(writeSettings({ notificationSound: false }));
  expect(config.notificationSound).toBe(false);
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(written.notificationSound).toBe(false);

  // Handing it back to the default is writing nothing, which is what the page sends when the
  // box is ticked again.
  await runEffect(writeSettings({ notificationSound: undefined }));
  expect(config.notificationSound).toBe(true);
  const cleared = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect("notificationSound" in cleared).toBe(false);
});

test("the file keeps what it had, including fields the core no longer names", async () => {
  // A legacy-only config file: the flat jira fields left the schema when the extension took them
  // over, so a settings-page write must carry them through the preserve decode rather than drop
  // them. This is the round-trip proof for those fields.
  await Bun.write(
    file,
    JSON.stringify({
      somethingNewer: 1,
      jiraAssignee: "me@example.com",
      jiraStartTransition: "Start",
      jiraDoneTransition: "Ready for release",
    }),
  );
  await runEffect(writeSettings({ notificationSound: false }));

  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  // A key we do not know about was put there by hand, for a version of IWE that does.
  expect(written.somethingNewer).toBe(1);
  // The write changed only what it meant to; the legacy jira fields survive intact.
  expect(written.jiraAssignee).toBe("me@example.com");
  expect(written.jiraStartTransition).toBe("Start");
  expect(written.jiraDoneTransition).toBe("Ready for release");
  expect(written.notificationSound).toBe(false);

  // The resolved config carries the preserved keys too, which is where the jira extension's
  // legacy fallback reads them from.
  expect((config as Config & { jiraAssignee?: string }).jiraAssignee).toBe("me@example.com");
});

test("a key the file no longer has does not survive a reload", async () => {
  // The one config object is refilled with Object.assign, so a key the new file does not mention
  // would stay readable from the previous file — a legacy field the page emptied, say. The
  // reload must drop what the file dropped, or the settings page cannot undo a hand edit.
  await Bun.write(file, JSON.stringify({ jiraDoneTransition: "Ready for release" }));
  reloadConfigSync();
  expect((config as Config & { jiraDoneTransition?: string }).jiraDoneTransition).toBe(
    "Ready for release",
  );

  await Bun.write(file, JSON.stringify({}));
  reloadConfigSync();
  expect("jiraDoneTransition" in config).toBe(false);
});

test("a workspace-level legacy jira object survives a settings save", async () => {
  // A workspace written before the settings bag carried its own `jira` site object. The loader
  // passes the entry through untouched, and the page writes the workspace back as it read it.
  await Bun.write(
    file,
    JSON.stringify({
      workspaces: [{ id: "client", name: "Client", jira: { project: "LEGACY", board: "B" } }],
    }),
  );
  reloadConfigSync();
  expect((config.workspaces[0] as Record<string, unknown>).jira).toEqual({
    project: "LEGACY",
    board: "B",
  });

  await runEffect(writeSettings({ workspaces: [config.workspaces[0]!] }));

  const written = JSON.parse(await readFile(file, "utf8")) as {
    workspaces: Record<string, unknown>[];
  };
  // The unknown key rode through the save, which is what the jira extension reads back.
  expect(written.workspaces[0]!.jira).toEqual({ project: "LEGACY", board: "B" });
  expect((config.workspaces[0] as Record<string, unknown>).jira).toEqual({
    project: "LEGACY",
    board: "B",
  });
});

test("a setting the environment overrides is reported as locked", async () => {
  process.env.IWE_WORKTREE_COPY = ".idea";
  reloadConfigSync();

  const view = settingsViewSync();
  expect(view.overridden.worktreeCopy).toBe("IWE_WORKTREE_COPY");
  expect(view.effective.worktreeCopy).toEqual([".idea"]);
  expect(view.path).toBe(file);
  // The default is offered back, so a page can undo a change to the list.
  expect(view.toolingDefault).toContain(".bsp");
});

test("an extension setting the environment overrides is reported as locked too", () => {
  process.env.IWE_JIRA_ASSIGNEE = "me@example.com";
  try {
    const view = settingsViewSync();
    // The jira extension's own declaration travels to the page, and the one field whose
    // environment variable is set is locked by name.
    const jira = view.extensions.find((e) => e.name === "jira");
    expect(jira?.globalSettings.map((f) => f.key)).toEqual([
      "assignee",
      "startTransition",
      "doneTransition",
    ]);
    expect(view.overriddenExtensions.jira).toEqual({ assignee: "IWE_JIRA_ASSIGNEE" });
  } finally {
    delete process.env.IWE_JIRA_ASSIGNEE;
  }
});

test("the extensions' own settings round-trip, strings and string lists", async () => {
  await runEffect(writeSettings({
    extensionSettings: {
      jira: { assignee: "me@example.com" },
      "azure-devops": { environments: ["dev", "accept"], pipeline: ["build-", "deploy-"] },
    },
  }));

  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(written.extensionSettings).toEqual({
    jira: { assignee: "me@example.com" },
    "azure-devops": { environments: ["dev", "accept"], pipeline: ["build-", "deploy-"] },
  });
  // The core carries the bag without looking inside: the object every module holds by
  // reference has it, untouched.
  expect(config.extensionSettings).toEqual(written.extensionSettings as Config["extensionSettings"]);

  // A later save keeps what the extensions wrote, and clearing a field means unset: the empty
  // string goes, the list stays.
  await runEffect(writeSettings({
    extensionSettings: {
      jira: { assignee: "" },
      "azure-devops": { environments: ["dev", "accept"] },
    },
  }));
  const again = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(again.extensionSettings).toEqual({
    "azure-devops": { environments: ["dev", "accept"] },
  });
});

test("the settings read migrates the retired names before the page edits them", async () => {
  // A hand-edited file still naming `ci` and `deployments`: the read folds them into the
  // extensions' own settings, so the page edits — and writes back — today's shape, never
  // the retired names.
  await Bun.write(
    file,
    JSON.stringify({
      extensionSettings: { deployments: { organization: "bag-org" } },
      workspaces: [
        { id: "old", name: "Old", extensions: ["ci", "git"] },
        { id: "no-pipes", name: "No pipelines", azure: false },
      ],
    }),
  );
  reloadConfigSync();

  const view = settingsViewSync();
  const written = view.file.workspaces ?? [];
  expect(written.find((w) => w.id === "old")?.extensions).toEqual([
    "github",
    "azure-devops",
    "git",
  ]);
  expect(written.find((w) => w.id === "no-pipes")?.extensions).not.toContain("azure-devops");
  expect(view.file.extensionSettings?.["azure-devops"]).toMatchObject({
    organization: "bag-org",
  });
  expect(view.file.extensionSettings).not.toHaveProperty("deployments");
});
