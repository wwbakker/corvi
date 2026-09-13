import { test, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testTempDir } from "./helpers.ts";

/**
 * `extension:install` and `extension:uninstall` manage one symlink in pi's extension directory.
 * The link may have been made by another checkout — another branch or worktree — and install has
 * to be free to repoint it here, and uninstall to remove it; only a real file there is somebody
 * else's to keep.
 */
const repoRoot = join(import.meta.dir, "..");
const source = join(repoRoot, "pi", "agent-state.ts");

let tmp: string;
let extensionsDir: string;
let installed: string;
/** Stands in for the same extension installed from another branch or worktree. */
let otherSource: string;

const run = (command: string): { code: number; stdout: string; stderr: string } => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "scripts/extension.ts", command],
    cwd: repoRoot,
    env: { ...process.env, PI_EXTENSIONS_DIR: extensionsDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

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
  const result = run("install");

  expect(result.code).toBe(0);
  expect(await readlink(installed)).toBe(source);
});

test("install twice is a no-op the second time", async () => {
  run("install");
  const result = run("install");

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("already installed");
  expect(await readlink(installed)).toBe(source);
});

test("install repoints a link another branch made", async () => {
  await symlink(otherSource, installed);

  const result = run("install");

  expect(result.code).toBe(0);
  expect(await readlink(installed)).toBe(source);
});

test("uninstall removes a link another branch made", async () => {
  await symlink(otherSource, installed);

  const result = run("uninstall");

  expect(result.code).toBe(0);
  expect(await present()).toBe(false);
});

test("uninstall with nothing installed is not a failure", () => {
  const result = run("uninstall");

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("not installed");
});

test("install and uninstall refuse to touch a real file", async () => {
  await writeFile(installed, "// somebody's own extension\n");

  expect(run("install").code).toBe(1);
  expect(run("uninstall").code).toBe(1);
  expect(await Bun.file(installed).text()).toBe("// somebody's own extension\n");
});
