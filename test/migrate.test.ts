import { beforeEach, expect, test } from "bun:test";
import { clearCache } from "../apps/server/src/capabilities/cache.ts";
import { loaded } from "../apps/server/src/integrations/index.ts";
import { migrateExtensionSettings } from "../apps/server/src/integrations/migrate.ts";
import { foldWorkspaceSettings } from "../apps/server/src/workspace/server/schema.ts";
import { legacyWorkspace, type LegacyWorkspaceKeys } from "./helpers.ts";
import type { Workspace } from "@corvi/configuration/config";

/**
 * The retired shapes fold into the settings' one shape: a workspace written before `settings`
 * existed becomes one (`foldWorkspaceSettings`), `ci` becomes the two cards that replaced it,
 * `deployments` becomes `azure-devops`, and the legacy per-workspace `azure` shapes land in the
 * `azure-devops` bag. Unknown names ride through untouched — they are the settings write's
 * complaint, not the migration's.
 *
 * `ws` states a fixture workspace: its own defaults, plus whatever retired keys a case needs,
 * declared as what they are rather than cast past.
 */
const ws = (
  patch: Omit<Partial<Workspace>, "id" | "name" | "settings"> & {
    settings?: Workspace["settings"];
  } & LegacyWorkspaceKeys = {},
): Workspace => ({
  id: "t",
  name: "T",
  ...patch,
});

/** The extensions list, read where the migration folds it. */
const names = (workspace: Workspace): string[] | undefined => workspace.settings?.extensions;
const bag = (workspace: Workspace): Record<string, unknown> | undefined =>
  workspace.settings?.extensionSettings as Record<string, unknown> | undefined;

beforeEach(() => clearCache());

test("a workspace written before `settings` folds into it, and what it says wins", () => {
  const old: Record<string, unknown> = {
    id: "old",
    name: "Old",
    repositoriesDirectory: "~/Repos/old",
    extensions: ["git"],
    extensionSettings: { jira: { project: "OLD" } },
    env: { GH_CONFIG_DIR: "~/.config/gh-old" },
    jira: { project: "LEGACY" },
  };
  foldWorkspaceSettings(old);
  // The decisions move into `settings`; anything else on the workspace stays where it is.
  expect(old).toEqual({
    id: "old",
    name: "Old",
    jira: { project: "LEGACY" },
    settings: {
      repositoriesDirectory: "~/Repos/old",
      extensions: ["git"],
      extensionSettings: { jira: { project: "OLD" } },
      env: { GH_CONFIG_DIR: "~/.config/gh-old" },
    },
  });

  // A value `settings` already speaks is never overwritten by a folded one, and folding twice
  // changes nothing.
  const both: Record<string, unknown> = {
    id: "b",
    name: "B",
    extensions: ["legacy"],
    settings: { extensions: ["chosen"] },
  };
  foldWorkspaceSettings(both);
  foldWorkspaceSettings(both);
  expect(both).toEqual({ id: "b", name: "B", settings: { extensions: ["chosen"] } });
});

test("ci becomes both cards, deployments becomes azure-devops, in place", () => {
  const workspace = ws({ settings: { extensions: ["ci", "git"] } });
  migrateExtensionSettings([workspace]);
  expect(names(workspace)).toEqual(["github", "azure-devops", "git"]);

  const page = ws({ settings: { extensions: ["deployments", "leftovers"] } });
  migrateExtensionSettings([page]);
  expect(names(page)).toEqual(["azure-devops", "leftovers"]);

  // Already migrated and unknown names: untouched.
  const done = ws({ settings: { extensions: ["github", "azure-devops", "nonexistent"] } });
  migrateExtensionSettings([done]);
  expect(names(done)).toEqual(["github", "azure-devops", "nonexistent"]);
});

test("a workspace that names nothing keeps naming nothing", () => {
  const silent = ws();
  migrateExtensionSettings([silent]);
  expect(names(silent)).toBeUndefined();
});

test("azure:false materializes the list without azure-devops, once", () => {
  const off = ws({ azure: false });
  migrateExtensionSettings([off]);
  expect(names(off)).toEqual(loaded.map((e) => e.name).filter((n) => n !== "azure-devops"));
  expect(names(off)).not.toContain("azure-devops");
  expect(legacyWorkspace(off).azure).toBeUndefined();

  // An explicit list is never rewritten by the flag — naming some is the whole list — but the
  // flag itself still leaves once its bag folded.
  const explicit = ws({ settings: { extensions: ["github"] }, azure: false });
  migrateExtensionSettings([explicit]);
  expect(names(explicit)).toEqual(["github"]);
  expect(legacyWorkspace(explicit).azure).toBeUndefined();
});

test("the deployments bags and the legacy azure object fold into azure-devops", () => {
  const bags = ws({
    settings: { extensionSettings: { deployments: { organization: "bag-org", project: "bag-proj" } } },
  });
  migrateExtensionSettings([bags]);
  expect(bag(bags)).toEqual({
    "azure-devops": { organization: "bag-org", project: "bag-proj" },
  });

  // The extension's own bag wins per field; the legacy object fills the gaps.
  const both = ws({
    azure: { organization: "legacy-org", project: "legacy-proj" },
    settings: { extensionSettings: { "azure-devops": { project: "own-proj" } } },
  });
  migrateExtensionSettings([both]);
  expect(bag(both)).toEqual({
    "azure-devops": { organization: "legacy-org", project: "own-proj" },
  });
  expect(legacyWorkspace(both).azure).toBeUndefined();

  // Running twice is a no-op: the second pass finds nothing retired to fold.
  const snapshot = JSON.stringify(both);
  migrateExtensionSettings([both]);
  expect(JSON.stringify(both)).toBe(snapshot);
});
