import { test, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runExtensionCommand, type AgentTargetName } from "../scripts/extension.ts";
import { testTempDir } from "./helpers.ts";

/**
 * `extension:install:<agent>` and `extension:uninstall:<agent>` manage one symlink per agent —
 * pi's extension directory and opencode's plugin directory. The link may have been made by
 * another checkout — another branch or worktree — and install has to be free to repoint it here,
 * and uninstall to remove it; only a real file there is somebody else's to keep.
 *
 * The commands are called in-process: they return the code and text the CLI prints, so the test
 * needs neither a spawned runtime nor a PATH lookup. Every rule is checked for both agents: the
 * targets differ only in source, destination and wording.
 */
const repoRoot = join(import.meta.dir, "..");
const sources: Readonly<Record<AgentTargetName, string>> = {
  pi: join(repoRoot, "integrations", "pi", "src", "agent-state.ts"),
  opencode: join(repoRoot, "integrations", "opencode", "src", "agent-state.ts"),
};

for (const name of ["pi", "opencode"] as const) {
  let tmp: string;
  let extensionsDir: string;
  let installed: string;
  /** Stands in for the same reporter installed from another branch or worktree. */
  let otherSource: string;

  const run = (command: string): ReturnType<typeof runExtensionCommand> =>
    runExtensionCommand(command, { [name]: extensionsDir });

  /** Whether anything at all is at the installed path. */
  const present = async (): Promise<boolean> =>
    (await lstat(installed).catch(() => undefined)) !== undefined;

  beforeEach(async () => {
    tmp = await testTempDir(`extension-${name}`);
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

  test(`install links ${name}'s plugin directory to this checkout`, async () => {
    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(await readlink(installed)).toBe(sources[name]);
  });

  test(`install twice is a no-op the second time (${name})`, async () => {
    await run(`install:${name}`);
    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already installed");
    expect(await readlink(installed)).toBe(sources[name]);
  });

  test(`install repoints a link another branch made (${name})`, async () => {
    await symlink(otherSource, installed);

    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(await readlink(installed)).toBe(sources[name]);
  });

  test(`uninstall removes a link another branch made (${name})`, async () => {
    await symlink(otherSource, installed);

    const result = await run(`uninstall:${name}`);

    expect(result.code).toBe(0);
    expect(await present()).toBe(false);
  });

  test(`uninstall with nothing installed is not a failure (${name})`, async () => {
    const result = await run(`uninstall:${name}`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("not installed");
  });

  test(`install and uninstall refuse to touch a real file (${name})`, async () => {
    await writeFile(installed, "// somebody's own extension\n");

    expect((await run(`install:${name}`)).code).toBe(1);
    expect((await run(`uninstall:${name}`)).code).toBe(1);
    expect(await Bun.file(installed).text()).toBe("// somebody's own extension\n");
  });
}

test("an unknown command prints the usage instead of guessing", async () => {
  expect((await runExtensionCommand("install")).code).toBe(1);
  expect((await runExtensionCommand("install:clang")).code).toBe(1);
  expect((await runExtensionCommand("remove:pi")).code).toBe(1);
  expect((await runExtensionCommand("install:pi:extra")).code).toBe(1);
  expect((await runExtensionCommand("")).code).toBe(1);
});
