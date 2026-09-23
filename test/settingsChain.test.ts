import { afterEach, expect, test } from "bun:test";
import { settingsFor } from "@corvi/configuration/settings";
import { extensionEnabled, extensionsFor } from "@corvi/configuration/workspaces";
import type { Config, SettingsOverrides, Workspace } from "@corvi/configuration/config";
import { ENV_OVERRIDES } from "../apps/server/src/settings/server/legacySettings.ts";

/**
 * The one precedence chain, over every setting key and at both scopes: an environment variable
 * wins at every scope, then the workspace's value, then the global one, then the default (which
 * the resolved config already carries). The table drives `settingsFor`, which is what every
 * reader goes through; the chain's own four levels are `resolveSetting`'s, exercised here
 * through the same calls.
 *
 * The one exception to the chain is a `secret` setting, whose `env` is a fallback rather than an
 * override: a stored token beats it. That rule lives with the reader that owns the credential —
 * `test/jira.flows.test.ts` ("a workspace that names its own token variable…") is where it is
 * proved.
 */

const globalConfig: Config = {
  changesRoot: "/global/changes",
  archiveRoot: "/global/archive",
  repositoriesDirectory: "/global/repos",
  notificationSound: true,
  contextMenu: true,
  ideationPrompt: "global prompt",
  worktreeCopy: [".global"],
  extensions: ["jira"],
  extensionSettings: { jira: { project: "GLOBAL" } },
  env: { GH_CONFIG_DIR: "/global/gh", GIT_AUTHOR_NAME: "Global" },
  workspaces: [],
};

const workspaceOf = (settings: SettingsOverrides | undefined): Workspace => ({
  id: "ws",
  name: "Ws",
  settings,
});

/** Every scalar or list setting: what the workspace says wins, and what it does not say
 * inherits the global level. */
const leafCases: {
  key: keyof SettingsOverrides;
  global: SettingsOverrides[keyof SettingsOverrides];
  own: SettingsOverrides[keyof SettingsOverrides];
}[] = [
  { key: "changesRoot", global: "/global/changes", own: "/ws/changes" },
  { key: "archiveRoot", global: "/global/archive", own: "/ws/archive" },
  { key: "repositoriesDirectory", global: "/global/repos", own: "/ws/repos" },
  { key: "notificationSound", global: true, own: false },
  { key: "contextMenu", global: true, own: false },
  { key: "ideationPrompt", global: "global prompt", own: "ws prompt" },
  { key: "worktreeCopy", global: [".global"], own: [".ws"] },
];

for (const { key, global, own } of leafCases) {
  test(`${key}: the workspace's value wins, and silence inherits the global one`, () => {
    // The suite's own environment overrides some of these keys by design (CORVI_ROOT and
    // friends); with one set, the variable wins at every scope and this case would be testing
    // that instead. Put it aside for the duration.
    const variable = ENV_OVERRIDES[key];
    const before = variable ? process.env[variable] : undefined;
    if (variable) delete process.env[variable];
    try {
      // The workspace overrides it…
      const overridden = settingsFor(globalConfig, workspaceOf({ [key]: own }), ENV_OVERRIDES);
      expect(overridden[key]).toEqual(own);
      // …and a workspace that says nothing gets the global level's answer.
      const inherited = settingsFor(globalConfig, workspaceOf({}), ENV_OVERRIDES);
      expect(inherited[key]).toEqual(global);
      // The global scope is the same shape without a workspace in the way.
      expect(settingsFor(globalConfig, undefined, ENV_OVERRIDES)[key]).toEqual(global);
    } finally {
      if (variable && before !== undefined) process.env[variable] = before;
    }
  });
}

test("an environment variable wins at every scope, and locks the field everywhere", () => {
  // The four keys the app names a variable for (ENV_OVERRIDES); the chain reads whatever names
  // it is handed, so this is the rule for every one of them.
  const withEnv: [keyof SettingsOverrides, string, string][] = [
    ["changesRoot", ENV_OVERRIDES.changesRoot!, "/env/changes"],
    ["archiveRoot", ENV_OVERRIDES.archiveRoot!, "/env/archive"],
    ["repositoriesDirectory", ENV_OVERRIDES.repositoriesDirectory!, "/env/repos"],
    ["worktreeCopy", ENV_OVERRIDES.worktreeCopy!, ".env1,.env2"],
  ];
  for (const [key, variable, raw] of withEnv) {
    const before = process.env[variable];
    process.env[variable] = raw;
    try {
      const expected = key === "worktreeCopy" ? [".env1", ".env2"] : raw;
      // Over a workspace that speaks…
      expect(settingsFor(globalConfig, workspaceOf({ [key]: ".ws" as never }), ENV_OVERRIDES)[key]).toEqual(
        expected,
      );
      // …and over the global level.
      expect(settingsFor(globalConfig, undefined, ENV_OVERRIDES)[key]).toEqual(expected);
    } finally {
      if (before === undefined) delete process.env[variable];
      else process.env[variable] = before;
    }
  }
});

test("the record-shaped settings resolve per key: the workspace's entries win, the rest inherit", () => {
  const applied = settingsFor(
    globalConfig,
    workspaceOf({ env: { GH_CONFIG_DIR: "/ws/gh" }, extensionSettings: { jira: { project: "WS" } } }),
    ENV_OVERRIDES,
  );
  // One key overridden, the other inherited — overriding one entry never clears the rest.
  expect(applied.env).toEqual({ GH_CONFIG_DIR: "/ws/gh", GIT_AUTHOR_NAME: "Global" });
  expect(applied.extensionSettings).toEqual({ jira: { project: "WS" } });

  // A workspace silent about them inherits both, whole.
  const inherited = settingsFor(globalConfig, workspaceOf({}), ENV_OVERRIDES);
  expect(inherited.env).toEqual(globalConfig.env);
  expect(inherited.extensionSettings).toEqual({ jira: { project: "GLOBAL" } });
});

test("the extensions list resolves down the same chain: the workspace's, the global's, all", () => {
  const listed = workspaceOf({ extensions: ["github"] });
  expect(settingsFor(globalConfig, listed, ENV_OVERRIDES).extensions).toEqual(["github"]);
  expect(settingsFor(globalConfig, workspaceOf({}), ENV_OVERRIDES).extensions).toEqual(["jira"]);
  // An empty list is a decision — none of them — where an absent one inherits.
  expect(settingsFor(globalConfig, workspaceOf({ extensions: [] }), ENV_OVERRIDES).extensions).toEqual(
    [],
  );
  expect(settingsFor({ ...globalConfig, extensions: undefined }, undefined, ENV_OVERRIDES).extensions)
    .toBeUndefined();

  // The enablement rule every surface asks: no list at all means every extension.
  expect(extensionEnabled(globalConfig, workspaceOf({}), "jira")).toBe(true);
  expect(extensionEnabled(globalConfig, workspaceOf({}), "github")).toBe(false);
  expect(extensionEnabled(globalConfig, workspaceOf({ extensions: ["github"] }), "github")).toBe(true);
  expect(extensionEnabled({ ...globalConfig, extensions: undefined }, workspaceOf({}), "anything")).toBe(
    true,
  );
  expect(extensionsFor(globalConfig, workspaceOf({}))).toEqual(["jira"]);
});
