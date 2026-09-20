import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cardsFor, loadDiscovered, loaded } from "../src/extension-host/index.ts";
import type { Change } from "../src/domain/change.ts";

/**
 * The portability proof: a one-line re-export of the github extension's default export, loaded
 * through the out-of-tree discovery path. It proves the discovery/install path works for a
 * built-in with no static in-repo registration, and that its surfaces answer through the
 * ordinary selectors rather than by reaching into the record.
 *
 * The registry is saved and cleared first: `install` rejects a second extension under a used
 * name, so this exercises the discovery path rather than finding the copy the host already
 * loaded.
 */

const repoRoot = join(import.meta.dir, "..");
const BUILTIN = "github";

let tmp: string;
let saved: typeof loaded = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "corvi-portability-"));
  saved = loaded.splice(0, loaded.length);
});

afterEach(async () => {
  loaded.splice(0, loaded.length, ...saved);
  await rm(tmp, { recursive: true, force: true });
});

const change = (): Change => ({
  id: "t",
  branch: "b",
  repos: [],
  createdAt: new Date().toISOString(),
});

test("a built-in installs from a re-exported module through the out-of-tree path", async () => {
  const moduleDir = join(tmp, "github-outside");
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
  expect(installed?.title).toBe("GitHub");

  // And its surfaces answer through the ordinary selectors.
  expect(cardsFor(change()).map((c) => c.name)).toEqual([BUILTIN]);
});
