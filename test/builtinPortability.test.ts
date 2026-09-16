import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cardsFor,
  loadDiscovered,
  loaded,
  looseEndContributorsFor,
  summaryContributorsFor,
  windowPresenters,
} from "../src/extension-host/index.ts";
import type { Workspace } from "../src/workspace/server/index.ts";
import type { Change } from "../src/domain/change.ts";
import type { TmuxWindow } from "../src/extension-host/api.ts";

/**
 * The portability proof, in two steps.
 *
 * The first test writes a one-line re-export of the github extension's default export and loads it
 * through the out-of-tree discovery path: it proves the discovery/install path works for a
 * built-in with no static in-repo registration.
 *
 * The second test copies the agents extension's own source out of the repository, rewriting its
 * only in-repo reference — the type-only contract import — to the contract's absolute address,
 * and asserts the presenter that installs behaves. That is the stronger claim: a built-in's own
 * code needs nothing from inside the repository but `src/extension-host/api.ts`.
 *
 * The registry is saved and cleared first: `install` rejects a second extension under a used
 * name, so these exercise the discovery path rather than finding the copy the host already
 * loaded. Surfaces are asserted through the same selectors the server uses.
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

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({ id: "t", name: "T", ...patch });
const change = (): Change => ({ id: "t", branch: "b", repos: [], createdAt: new Date().toISOString() });

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

  // And its surfaces answer through the ordinary selectors, not by reaching into the record.
  expect(cardsFor(change()).map((c) => c.name)).toEqual([BUILTIN]);
  expect(summaryContributorsFor(workspace()).map((c) => c.name)).toEqual([BUILTIN]);
  expect(looseEndContributorsFor(workspace()).map((c) => c.name)).toEqual([BUILTIN]);

  // Enablement governs a discovered built-in exactly as it governs a static one.
  expect(summaryContributorsFor(workspace({ extensions: [] }))).toEqual([]);
});

/** The tmux facts a presenter reads, with the agent options under test filled in per case. */
const windowFacts = (options: Record<string, string>): TmuxWindow => ({
  index: 0,
  name: "node",
  command: "node",
  active: true,
  activity: false,
  directory: "/repos/example-api",
  named: false,
  options,
  id: "@1",
});

test("a built-in's own source installs from outside the repository with only the contract", async () => {
  const source = await readFile(join(repoRoot, "src", "extensions", "agents", "index.ts"), "utf8");
  const contract = pathToFileURL(join(repoRoot, "src", "extension-host", "api.ts")).href;
  // The agents extension's only in-repo reference is the contract, as a type-only import.
  // Rewriting it to the contract's absolute address is the whole portability claim: nothing
  // else in its source points inside the repository.
  const rewritten = source.replace('"../../extension-host/api.ts"', JSON.stringify(contract));
  expect(rewritten).not.toBe(source);
  expect(rewritten).not.toContain("../../");

  const moduleDir = join(tmp, "agents-outside");
  await mkdir(moduleDir, { recursive: true });
  const modulePath = join(moduleDir, "index.ts");
  await writeFile(modulePath, rewritten);

  expect(loaded).toEqual([]);
  await loadDiscovered([modulePath]);

  const installed = loaded.find((e) => e.name === "agents");
  expect(installed).toBeDefined();

  // The copied module's presenter answers for an agent window: its own behaviour came through,
  // not merely its registration.
  const [presenter] = windowPresenters();
  expect(presenter).toBeDefined();
  expect(
    presenter!.present(
      windowFacts({ "@agent_status": "working", "@agent_session_name": "example-api" }),
    ),
  ).toEqual({
    label: "example-api",
    running: "pi working",
    icon: "agent",
    state: "ok",
    busy: true,
    attention: false,
    note: undefined,
  });
  // And it falls through for a plain shell, exactly as the built-in does.
  expect(presenter!.present(windowFacts({}))).toBeUndefined();
});
