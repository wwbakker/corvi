import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cardsFor,
  loadDiscovered,
  loaded,
  looseEndContributorsFor,
  summaryContributorsFor,
} from "../src/core/host/index.ts";
import type { Workspace } from "../src/workspace/server/index.ts";
import type { Change } from "../src/core/domain/change.ts";

/**
 * The portability proof: a real built-in installs through the out-of-tree discovery path with
 * no static in-repo registration. The module written here is a one-line re-export of the ci
 * extension's default export — the same description the loader would have imported statically —
 * and `loadDiscovered` imports it from disk and installs it like any third-party module.
 *
 * The registry is saved and cleared first: `install` rejects a second extension under a used
 * name, so this exercises the discovery path for the built-in rather than finding the copy the
 * host already loaded. Its surfaces are asserted through the same selectors the server uses,
 * which is what "the built-in works from outside the repository" means in code.
 */

const repoRoot = join(import.meta.dir, "..");
const BUILTIN = "ci";

let tmp: string;
let saved: typeof loaded = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-portability-"));
  saved = loaded.splice(0, loaded.length);
});

afterEach(async () => {
  loaded.splice(0, loaded.length, ...saved);
  await rm(tmp, { recursive: true, force: true });
});

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({ id: "t", name: "T", ...patch });
const change = (): Change => ({ id: "t", branch: "b", repos: [], createdAt: new Date().toISOString() });

test("a built-in installs from a re-exported module through the out-of-tree path", async () => {
  const moduleDir = join(tmp, "ci-outside");
  await mkdir(moduleDir, { recursive: true });
  const modulePath = join(moduleDir, "index.ts");
  const builtinPath = join(repoRoot, "src", "extensions", BUILTIN, "index.ts");
  // The extension module, discovered and imported from disk: its default export is the
  // built-in's own description, re-exported. Nothing in this repository's loader names it.
  await writeFile(
    modulePath,
    `export { default } from ${JSON.stringify(pathToFileURL(builtinPath).href)};\n`,
  );

  expect(loaded).toEqual([]);
  await loadDiscovered([modulePath]);

  // The description installed, name and title intact.
  const installed = loaded.find((e) => e.name === BUILTIN);
  expect(installed).toBeDefined();
  expect(installed?.title).toBe("CI");

  // And its surfaces answer through the ordinary selectors, not by reaching into the record.
  expect(cardsFor(change()).map((c) => c.name)).toEqual([BUILTIN]);
  expect(summaryContributorsFor(workspace()).map((c) => c.name)).toEqual([BUILTIN]);
  expect(looseEndContributorsFor(workspace()).map((c) => c.name)).toEqual([BUILTIN]);

  // Enablement governs a discovered built-in exactly as it governs a static one.
  expect(summaryContributorsFor(workspace({ extensions: [] }))).toEqual([]);
});
