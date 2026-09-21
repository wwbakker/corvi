import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MASK, problems, settingsViewSync, writeSettings, type Settings } from "../apps/server/src/settings/server/index.ts";
import { runtimeConfig, reloadConfigSync, type Config } from "../apps/server/src/workspace/server/index.ts";
import { runEffect } from "./helpers.ts";

/**
 * The settings page writes the file the whole program reads, so the two things worth testing are
 * that a bad value never reaches it and that a good one takes effect without a restart. The
 * validation is on the server because the file is hand-editable too: rules in the browser only
 * would be rules that half the ways in ignore.
 */
let tmp: string;
let file: string;
const originalConfig = process.env.CORVI_CONFIG;
// Other test files point CORVI_ROOT at their own temporary directory, and the environment beats
// the file by design — with it set, a written changesRoot would correctly have no effect and
// this file would be testing the override instead.
const originalRoot = process.env.CORVI_ROOT;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-settings-"));
  file = join(tmp, "runtimeConfig().json");
  process.env.CORVI_CONFIG = file;
  delete process.env.CORVI_ROOT;
  reloadConfigSync();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env.CORVI_CONFIG;
  else process.env.CORVI_CONFIG = originalConfig;
  if (originalRoot !== undefined) process.env.CORVI_ROOT = originalRoot;
  // Other tests share this process, and a config left pointing at a deleted file is a test that
  // fails somewhere else for a reason nobody can see.
  reloadConfigSync();
});

afterEach(() => {
  delete process.env.CORVI_WORKTREE_COPY;
});

test("what cannot be written", () => {
  expect(problems({ changesRoot: "changes" })).toEqual(["changesRoot must be an absolute path"]);
  // `~` is a path the program can resolve, so it is one the page may offer.
  expect(problems({ changesRoot: "~/changes" })).toEqual([]);
  // The repositories directory is a path like any other: the browser is unbounded, so nothing
  // bounds it, but a relative one still has nowhere to start.
  expect(problems({ repositoriesDirectory: "Repos" })).toEqual([
    "repositoriesDirectory must be an absolute path",
  ]);
  expect(problems({ repositoriesDirectory: "~/Repos" })).toEqual([]);

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

  // A context's own repositories directory follows the same rule as the global one.
  expect(
    problems({ workspaces: [{ id: "c", name: "C", repositoriesDirectory: "relative" }] }),
  ).toEqual(["C: repositories directory must be an absolute path"]);
  expect(
    problems({ workspaces: [{ id: "c", name: "C", repositoriesDirectory: "~/Repos/acme" }] }),
  ).toEqual([]);
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
  expect(runtimeConfig().changesRoot).toBe(join(tmp, "changes"));
  expect(runtimeConfig().worktreeCopy).toEqual([".idea"]);
  expect(runtimeConfig().workspaces.map((w) => w.id)).toEqual(["client", "own"]);
  // The shapes the page wrote land on the object every module reads, untouched.
  expect(runtimeConfig().workspaces[0]!.extensionSettings).toEqual({ jira: { project: "PROJ" } });
  expect(runtimeConfig().workspaces[1]!.extensions).toEqual(["github", "git"]);

  expect(runEffect(writeSettings({ workspaces: [{ id: "", name: "Nameless" }] }))).rejects.toThrow(/no id/);
  // Refused means unchanged, not half written.
  expect(reloadConfigSync().workspaces.map((w) => w.id)).toEqual(["client", "own"]);
});

test("silencing notifications is a decision the file keeps; absent means sound", async () => {
  // The default is on, and only the decision to silence is written down, so an untouched file
  // stays a page of decisions rather than a dump of defaults.
  expect(reloadConfigSync().notificationSound).toBe(true);

  await runEffect(writeSettings({ notificationSound: false }));
  expect(runtimeConfig().notificationSound).toBe(false);
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(written.notificationSound).toBe(false);

  // Handing it back to the default is writing nothing, which is what the page sends when the
  // box is ticked again.
  await runEffect(writeSettings({ notificationSound: undefined }));
  expect(runtimeConfig().notificationSound).toBe(true);
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
  // A key we do not know about was put there by hand, for a version of Corvi that does.
  expect(written.somethingNewer).toBe(1);
  // The write changed only what it meant to; the legacy jira fields survive intact.
  expect(written.jiraAssignee).toBe("me@example.com");
  expect(written.jiraStartTransition).toBe("Start");
  expect(written.jiraDoneTransition).toBe("Ready for release");
  expect(written.notificationSound).toBe(false);

  // The resolved config carries the preserved keys too, which is where the jira extension's
  // legacy fallback reads them from.
  expect((runtimeConfig() as Config & { jiraAssignee?: string }).jiraAssignee).toBe("me@example.com");
});

test("a key the file no longer has does not survive a reload", async () => {
  // The one config object is refilled with Object.assign, so a key the new file does not mention
  // would stay readable from the previous file — a legacy field the page emptied, say. The
  // reload must drop what the file dropped, or the settings page cannot undo a hand edit.
  await Bun.write(file, JSON.stringify({ jiraDoneTransition: "Ready for release" }));
  reloadConfigSync();
  expect((runtimeConfig() as Config & { jiraDoneTransition?: string }).jiraDoneTransition).toBe(
    "Ready for release",
  );

  await Bun.write(file, JSON.stringify({}));
  reloadConfigSync();
  expect("jiraDoneTransition" in runtimeConfig()).toBe(false);
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
  expect((runtimeConfig().workspaces[0] as Record<string, unknown>).jira).toEqual({
    project: "LEGACY",
    board: "B",
  });

  await runEffect(writeSettings({ workspaces: [runtimeConfig().workspaces[0]!] }));

  const written = JSON.parse(await readFile(file, "utf8")) as {
    workspaces: Record<string, unknown>[];
  };
  // The unknown key rode through the save, which is what the jira extension reads back.
  expect(written.workspaces[0]!.jira).toEqual({ project: "LEGACY", board: "B" });
  expect((runtimeConfig().workspaces[0] as Record<string, unknown>).jira).toEqual({
    project: "LEGACY",
    board: "B",
  });
});

test("a setting the environment overrides is reported as locked", async () => {
  process.env.CORVI_WORKTREE_COPY = ".idea";
  reloadConfigSync();

  const view = settingsViewSync();
  expect(view.overridden.worktreeCopy).toBe("CORVI_WORKTREE_COPY");
  expect(view.effective.worktreeCopy).toEqual([".idea"]);
  expect(view.path).toBe(file);
  // The default is offered back, so a page can undo a change to the list.
  expect(view.toolingDefault).toContain(".bsp");
});

test("the repositories directory's environment override wins, and the page is told", () => {
  const original = process.env.CORVI_REPOSITORIES_DIRECTORY;
  process.env.CORVI_REPOSITORIES_DIRECTORY = "/tmp/env-repos";
  try {
    reloadConfigSync();
    const view = settingsViewSync();
    expect(view.overridden.repositoriesDirectory).toBe("CORVI_REPOSITORIES_DIRECTORY");
    expect(view.effective.repositoriesDirectory).toBe("/tmp/env-repos");
  } finally {
    if (original === undefined) delete process.env.CORVI_REPOSITORIES_DIRECTORY;
    else process.env.CORVI_REPOSITORIES_DIRECTORY = original;
    // One config object, shared with the rest of this file: put the file's answer back.
    reloadConfigSync();
  }
});

test("an extension setting the environment overrides is reported as locked too", () => {
  process.env.CORVI_JIRA_ASSIGNEE = "me@example.com";
  try {
    const view = settingsViewSync();
    // The jira extension's own declaration travels to the page, and the one field whose
    // environment variable is set is locked by name. The site comes first — it is what the rest
    // of the section is about — and the token is the one secret at both levels.
    const jira = view.extensions.find((e) => e.name === "jira");
    expect(jira?.globalSettings.map((f) => f.key)).toEqual([
      "server",
      "email",
      "project",
      "board",
      "token",
      "tokenEnv",
      "assignee",
      "startTransition",
      "doneTransition",
    ]);
    expect(jira?.workspaceSettings.map((f) => f.key)).toEqual([
      "server",
      "email",
      "project",
      "board",
      "token",
      "tokenEnv",
    ]);
    expect(jira?.globalSettings.filter((f) => f.secret).map((f) => f.key)).toEqual(["token"]);
    expect(jira?.workspaceSettings.filter((f) => f.secret).map((f) => f.key)).toEqual(["token"]);
    expect(view.overriddenExtensions.jira).toEqual({ assignee: "CORVI_JIRA_ASSIGNEE" });
  } finally {
    delete process.env.CORVI_JIRA_ASSIGNEE;
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
  expect(runtimeConfig().extensionSettings).toEqual(written.extensionSettings as Config["extensionSettings"]);

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

test("a declared secret never reaches the page, and not retyping it keeps it", async () => {
  await runEffect(
    writeSettings({
      extensionSettings: { jira: { server: "https://x.example", token: "root-secret" } },
      workspaces: [
        { id: "client", name: "Client", extensionSettings: { jira: { token: "client-secret" } } },
      ],
    }),
  );

  const view = settingsViewSync();
  // The mask where a secret is stored, at both levels, in the file and in what is in effect.
  expect(view.file.extensionSettings?.["jira"]?.["token"]).toBe(MASK);
  expect(view.effective.extensionSettings?.["jira"]?.["token"]).toBe(MASK);
  expect(view.file.workspaces?.[0]?.extensionSettings?.["jira"]?.["token"]).toBe(MASK);
  expect(view.effective.workspaces?.[0]?.extensionSettings?.["jira"]?.["token"]).toBe(MASK);
  // The running config still holds the real one: the redaction copies rather than mutating the
  // object every request is reading.
  expect(runtimeConfig().extensionSettings?.["jira"]?.["token"]).toBe("root-secret");
  expect(runtimeConfig().workspaces[0]?.extensionSettings?.["jira"]?.["token"]).toBe("client-secret");

  // A save that sends the mask back — a page that edited anything else — keeps what is stored.
  await runEffect(writeSettings(view.file));
  expect(runtimeConfig().extensionSettings?.["jira"]?.["token"]).toBe("root-secret");
  expect(runtimeConfig().workspaces[0]?.extensionSettings?.["jira"]?.["token"]).toBe("client-secret");
  const kept = await readFile(file, "utf8");
  expect(kept).toContain("root-secret");
  expect(kept).not.toContain(MASK);

  // A retyped token replaces it, and an emptied field falls back to the environment.
  await runEffect(writeSettings({ extensionSettings: { jira: { token: "new-secret" } } }));
  expect(runtimeConfig().extensionSettings?.["jira"]?.["token"]).toBe("new-secret");
  await runEffect(writeSettings({ extensionSettings: { jira: { token: "" } } }));
  expect(runtimeConfig().extensionSettings?.["jira"]?.["token"]).toBeUndefined();
});

test("a mask for a secret nothing is stored in is not written as one", async () => {
  // A page open before the token existed sends the mask for a field the file does not have; what
  // it must not do is make the mask the token.
  await runEffect(writeSettings({ extensionSettings: { jira: { server: "https://x.example" } } }));
  await runEffect(
    writeSettings({ extensionSettings: { jira: { server: "https://x.example", token: MASK } } }),
  );

  expect(runtimeConfig().extensionSettings?.["jira"]?.["token"]).toBeUndefined();
  expect(await readFile(file, "utf8")).not.toContain(MASK);
});

test("the settings file is written for its owner alone", async () => {
  await runEffect(writeSettings({ extensionSettings: { jira: { token: "hunter2" } } }));
  // It may hold a token, and a mode that depended on whether it happened to would flap.
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
