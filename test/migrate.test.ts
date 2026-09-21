import { beforeEach, expect, test } from "bun:test";
import { clearCache } from "../src/capabilities/cache.ts";
import { loaded } from "../src/integrations/index.ts";
import { migrateExtensionSettings } from "../src/integrations/migrate.ts";
import type { Workspace } from "@corvi/configuration/config";

/**
 * The retired names fold into the extensions' own settings: `ci` becomes the two cards that
 * replaced it, `deployments` becomes `azure-devops`, and the legacy per-workspace `azure`
 * shapes land in the `azure-devops` bag. Unknown names ride through untouched — they are the
 * settings write's complaint, not the migration's.
 */
const ws = (patch: Record<string, unknown> = {}): Workspace =>
  ({ id: "t", name: "T", ...patch }) as Workspace;

beforeEach(() => clearCache());

test("ci becomes both cards, deployments becomes azure-devops, in place", () => {
  const workspace = ws({ extensions: ["ci", "git"] });
  migrateExtensionSettings([workspace]);
  expect(workspace.extensions).toEqual(["github", "azure-devops", "git"]);

  const page = ws({ extensions: ["deployments", "leftovers"] });
  migrateExtensionSettings([page]);
  expect(page.extensions).toEqual(["azure-devops", "leftovers"]);

  // Already migrated and unknown names: untouched.
  const done = ws({ extensions: ["github", "azure-devops", "nonexistent"] });
  migrateExtensionSettings([done]);
  expect(done.extensions).toEqual(["github", "azure-devops", "nonexistent"]);
});

test("a workspace that names nothing keeps naming nothing", () => {
  const silent = ws();
  migrateExtensionSettings([silent]);
  expect(silent.extensions).toBeUndefined();
});

test("azure:false materializes the list without azure-devops, once", () => {
  const off = ws({ azure: false } as never);
  migrateExtensionSettings([off]);
  expect(off.extensions).toEqual(loaded.map((e) => e.name).filter((n) => n !== "azure-devops"));
  expect(off.extensions).not.toContain("azure-devops");
  expect((off as Record<string, unknown>).azure).toBeUndefined();

  // An explicit list is never rewritten by the flag — naming some is the whole list — but the
  // flag itself still leaves once its bag folded.
  const explicit = ws({ extensions: ["github"], azure: false } as never);
  migrateExtensionSettings([explicit]);
  expect(explicit.extensions).toEqual(["github"]);
  expect((explicit as Record<string, unknown>).azure).toBeUndefined();
});

test("the deployments bags and the legacy azure object fold into azure-devops", () => {
  const bags = ws({
    extensionSettings: { deployments: { organization: "bag-org", project: "bag-proj" } },
  });
  migrateExtensionSettings([bags]);
  expect(bags.extensionSettings).toEqual({
    "azure-devops": { organization: "bag-org", project: "bag-proj" },
  });

  // The extension's own bag wins per field; the legacy object fills the gaps.
  const both = ws({
    azure: { organization: "legacy-org", project: "legacy-proj" },
    extensionSettings: { "azure-devops": { project: "own-proj" } },
  } as never);
  migrateExtensionSettings([both]);
  expect(both.extensionSettings).toEqual({
    "azure-devops": { organization: "legacy-org", project: "own-proj" },
  });
  expect((both as Record<string, unknown>).azure).toBeUndefined();

  // Running twice is a no-op: the second pass finds nothing retired to fold.
  const snapshot = JSON.stringify(both);
  migrateExtensionSettings([both]);
  expect(JSON.stringify(both)).toBe(snapshot);
});
