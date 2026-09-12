import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testRun, testTempDir } from "./helpers.ts";
import {
  extensionModulePaths,
  loadDiscovered,
  loaded,
  wizardStepsFor,
} from "../src/extension-host/index.ts";
import { homedir } from "node:os";
import type { Workspace } from "../src/workspace/server/index.ts";

/**
 * Out-of-tree extensions: modules that do not live in this repository, discovered from the
 * config (or an environment override), imported from disk through the same install path as
 * the built-ins, and served to the page as chunks the server built (src/extension-host/clientChunks.ts).
 *
 * The extension written here is deliberately the shape docs/guides/extensions.md promises: a default
 * export with a wizard step, plus a sibling client.tsx — nothing else, and no host imports.
 */

const repoRoot = join(import.meta.dir, "..");
const NAME = "out-of-tree-test";

let tmp: string;
let extensionDir: string;

beforeAll(async () => {
  tmp = await testTempDir("out-of-tree");
  extensionDir = join(tmp, "my-extension");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "index.ts"),
    `export default {
      name: "${NAME}",
      title: "Out of tree",
      wizardSteps: [{ id: "${NAME}", title: "Out of tree", phase: "repos" }],
    };\n`,
  );
  // The client half: one module exporting `step`, `page` and `tab`, per the contract. No react
  // import, so the built chunk has nothing to resolve — the import map's work is the
  // server-boot test's vendor assertions below.
  await writeFile(
    join(extensionDir, "client.tsx"),
    `export const step = () => null;\nexport const page = () => null;\nexport const tab = () => null;\n`,
  );
  // The env override is how a test — or a one-off run — points the loader somewhere else.
  process.env.IWE_EXTENSION_PATHS = tmp;
  await loadDiscovered([extensionDir]);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ws = (patch: Partial<Workspace> = {}): Workspace => ({ id: "t", name: "T", ...patch });

test("a discovered extension is loaded through the same path as the built-ins", () => {
  const ext = loaded.find((e) => e.name === NAME);
  expect(ext).toBeDefined();
  expect(ext?.title).toBe("Out of tree");
  // The sibling client.tsx of the module file is the half the server builds for the page.
  expect(ext?.clientPath).toBe(join(extensionDir, "client.tsx"));
});

test("the discovered extension's wizard step answers through the ordinary query", () => {
  expect(wizardStepsFor(ws({ extensions: [NAME] })).map((s) => [s.extension, s.id, s.phase])).toEqual([
    [NAME, NAME, "repos"],
  ]);
  // And enablement governs it like any built-in: unlisted is absent.
  expect(wizardStepsFor(ws({ extensions: [] }))).toEqual([]);
});

test("discovery expands a directory into its modules, ignoring duplicates", () => {
  // The directory contributes its subdirectory index.ts files; naming it twice loads it once.
  expect(extensionModulePaths([tmp, extensionDir, tmp])).toEqual([
    join(extensionDir, "index.ts"),
  ]);
  // A file path is the module itself, in the order given.
  expect(extensionModulePaths([join(extensionDir, "index.ts")])).toEqual([
    join(extensionDir, "index.ts"),
  ]);
  // A path that does not exist is skipped, not fatal.
  expect(extensionModulePaths([join(tmp, "nope")])).toEqual([]);
});

test("a broken extension is skipped with a word, never a thrown load", async () => {
  const broken = join(tmp, "broken");
  await mkdir(broken, { recursive: true });
  // A module that throws on import; one without a default export; a factory that fails.
  await writeFile(join(broken, "throws.ts"), `throw new Error("import blew up");\n`);
  await writeFile(join(broken, "noexport.ts"), `export const side = true;\n`);
  await writeFile(
    join(broken, "factory.ts"),
    `export default () => { throw new Error("factory failed"); };\n`,
  );
  const before = loaded.length;
  await expect(
    loadDiscovered([broken, join(tmp, "also-missing")]),
  ).resolves.toBeUndefined();
  expect(loaded.length).toBe(before);
});

test("the environment override wins over the file, tilde-expanded and deduplicated", async () => {
  const run = async (env: Record<string, string>): Promise<string[]> => {
    const configFile = join(tmp, `config-${Math.random()}.json`);
    // The file always names a path of its own; only the override decides whether it wins.
    await writeFile(configFile, JSON.stringify({ extensionPaths: ["/from-the-file"] }));
    // This file's beforeAll set the override in the test process itself; the child starts
    // from a clean slate and gets exactly the env the case under test names.
    const base = { ...process.env };
    delete base.IWE_EXTENSION_PATHS;
    const proc = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `console.log(JSON.stringify((await import("${join(repoRoot, "src/workspace/server/config.ts")}")).config.extensionPaths))`,
      ],
      cwd: repoRoot,
      env: { ...base, IWE_CONFIG: configFile, IWE_ROOT: join(tmp, "changes"), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return JSON.parse(proc.stdout.toString().trim()) as string[];
  };

  // The override wins over the file, duplicates are dropped, ~ is expanded.
  expect(await run({ IWE_EXTENSION_PATHS: `/from-the-file,~/exts` })).toEqual([
    "/from-the-file",
    join(homedir(), "exts"),
  ]);
  // Without the override, the file's own list stands.
  expect(await run({})).toEqual(["/from-the-file"]);
});

test("the server serves the built client chunk and the react vendor chunks", async () => {
  const port = 4700 + Math.floor(Math.random() * 200);
  // A config file of its own, naming the extension through the file path this time — the
  // override above proved the env path; this proves the file path.
  const configFile = join(tmp, "boot-config.json");
  await writeFile(configFile, JSON.stringify({ extensionPaths: [extensionDir] }));
  const server = Bun.spawn(["bun", "src/server.ts", `--iwe-test-run=${testRun()}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      IWE_EXTENSION_PATHS: "", // the file's list, not the inherited override
      IWE_PORT: String(port),
      IWE_ROOT: join(tmp, "changes"),
      IWE_REPOS_ROOT: tmp,
      IWE_CONFIG: configFile,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 150; i++) {
      if ((await fetch(`http://127.0.0.1:${port}/api/changes`).catch(() => null))?.ok) {
        up = true;
        break;
      }
      await Bun.sleep(100);
    }
    expect(up).toBe(true);

    // The wizard knows the step (the file-configured extension was loaded by this boot).
    const wizard = (await fetch(`http://127.0.0.1:${port}/api/wizard`).then((r) => r.json())) as {
      steps: { extension: string }[];
    };
    expect(wizard.steps.map((s) => s.extension)).toContain(NAME);

    // The server-built client chunk: javascript, and each contract export — a step, a page and a
    // tab — survives the build, so one served chunk can serve any of the three surfaces.
    const client = await fetch(`http://127.0.0.1:${port}/extensions/${NAME}/client.js`);
    expect(client.status).toBe(200);
    expect(client.headers.get("content-type")).toContain("text/javascript");
    const chunk = await client.text();
    expect(chunk).toContain("step");
    expect(chunk).toContain("page");
    expect(chunk).toContain("tab");

    // The vendor chunks the import map points the chunk's react specifiers at: the app's own
    // react, served for the page and the out-of-tree chunk to share.
    for (const file of ["react.js", "react-dom.js", "react-jsx-runtime.js", "react-dom-client.js"]) {
      const vendor = await fetch(`http://127.0.0.1:${port}/vendor/${file}`);
      expect(vendor.status).toBe(200);
      expect(vendor.headers.get("content-type")).toContain("text/javascript");
      expect((await vendor.text()).length).toBeGreaterThan(0);
    }

    // An extension nobody loaded has no chunk: 404, not something that looks like javascript.
    const missing = await fetch(`http://127.0.0.1:${port}/extensions/nobody/client.js`);
    expect(missing.status).toBe(404);
  } finally {
    server.kill();
  }
}, 60_000);
