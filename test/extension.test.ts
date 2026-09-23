import { test, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runExtensionCommand } from "../scripts/extension.ts";
import { testTempDir } from "./helpers.ts";

/**
 * `extension:install` and `extension:uninstall` manage one symlink in pi's extension directory.
 * The link may have been made by another checkout — another branch or worktree — and install has
 * to be free to repoint it here, and uninstall to remove it; only a real file there is somebody
 * else's to keep.
 *
 * The commands are called in-process: they return the code and text the CLI prints, so the test
 * needs neither a spawned runtime nor a PATH lookup.
 */
const repoRoot = join(import.meta.dir, "..");
const source = join(repoRoot, "pi", "agent-state.ts");

let tmp: string;
let extensionsDir: string;
let installed: string;
/** Stands in for the same extension installed from another branch or worktree. */
let otherSource: string;

const run = (command: string): ReturnType<typeof runExtensionCommand> =>
  runExtensionCommand(command, extensionsDir);

/** Whether anything at all is at the installed path. */
const present = async (): Promise<boolean> =>
  (await lstat(installed).catch(() => undefined)) !== undefined;

beforeEach(async () => {
  tmp = await testTempDir("extension");
  extensionsDir = join(tmp, "extensions");
  installed = join(extensionsDir, "agent-state.ts");
  otherSource = join(tmp, "other-branch", "agent-state.ts");
  await mkdir(extensionsDir, { recursive: true });
  await mkdir(join(tmp, "other-branch"), { recursive: true });
  await writeFile(otherSource, "// another branch\n");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("install links pi's extension directory to this checkout", async () => {
  const result = await run("install");

  expect(result.code).toBe(0);
  expect(await readlink(installed)).toBe(source);
});

test("install twice is a no-op the second time", async () => {
  await run("install");
  const result = await run("install");

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("already installed");
  expect(await readlink(installed)).toBe(source);
});

test("install repoints a link another branch made", async () => {
  await symlink(otherSource, installed);

  const result = await run("install");

  expect(result.code).toBe(0);
  expect(await readlink(installed)).toBe(source);
});

test("uninstall removes a link another branch made", async () => {
  await symlink(otherSource, installed);

  const result = await run("uninstall");

  expect(result.code).toBe(0);
  expect(await present()).toBe(false);
});

test("uninstall with nothing installed is not a failure", async () => {
  const result = await run("uninstall");

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("not installed");
});

test("install and uninstall refuse to touch a real file", async () => {
  await writeFile(installed, "// somebody's own extension\n");

  expect((await run("install")).code).toBe(1);
  expect((await run("uninstall")).code).toBe(1);
  expect(await Bun.file(installed).text()).toBe("// somebody's own extension\n");
});
