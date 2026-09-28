import { test, expect, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runExtensionCommand, type AgentTargetName } from "../scripts/extension.ts";
import { testTempDir } from "./helpers.ts";

/**
 * `extension:install:<agent>` and `extension:uninstall:<agent>` manage one install per agent —
 * pi's extension directory and opencode's plugin directory — in the shape each loader needs: pi
 * resolves a module's imports beside the file it loaded, so its install is a directory of links;
 * opencode follows the link to the entry, so its install is one link. The install is ours only
 * when the entry at it is one of our symlinks, and the links may have been made by another
 * checkout — another branch or worktree — so install has to be free to repoint them here, and
 * uninstall to remove them; only a real file or directory there is somebody else's to keep.
 *
 * The commands are called in-process: they return the code and text the CLI prints, so the test
 * needs neither a spawned runtime nor a PATH lookup. Every rule is checked for both agents.
 */
const repoRoot = join(import.meta.dir, "..");
const sources: Readonly<Record<AgentTargetName, string>> = {
  pi: join(repoRoot, "integrations", "pi", "src"),
  opencode: join(repoRoot, "integrations", "opencode", "src"),
};

for (const name of ["pi", "opencode"] as const) {
  const isDirectoryLayout = name === "pi";
  let tmp: string;
  let extensionsDir: string;
  let installed: string;
  /** Where the entry link lives: beside its modules (pi) or at the install itself (opencode). */
  let entryLink: string;
  /** The two shapes older Corvis installed: the reporter alone, then one link to one file. */
  let legacyState: string;
  let legacyEntry: string;
  /** Stands in for the same extension installed from another branch or worktree. */
  let otherSource: string;

  const run = (command: string): ReturnType<typeof runExtensionCommand> =>
    runExtensionCommand(command, { [name]: extensionsDir });

  /** Whether anything at all is at the installed path. */
  const present = async (): Promise<boolean> =>
    (await lstat(installed).catch(() => undefined)) !== undefined;

  /** An install of this extension made by another checkout, in the same shape. */
  const otherInstall = async (): Promise<void> => {
    if (isDirectoryLayout) {
      await mkdir(installed, { recursive: true });
      await symlink(join(otherSource, "index.ts"), join(installed, "index.ts"));
      await symlink(join(otherSource, "turns.ts"), join(installed, "turns.ts"));
    } else {
      await symlink(join(otherSource, "index.ts"), installed);
    }
  };

  beforeEach(async () => {
    tmp = await testTempDir(`extension-${name}`);
    extensionsDir = join(tmp, "extensions");
    installed = join(extensionsDir, isDirectoryLayout ? "corvi" : "corvi.ts");
    entryLink = isDirectoryLayout ? join(installed, "index.ts") : installed;
    legacyState = join(extensionsDir, "agent-state.ts");
    legacyEntry = join(extensionsDir, "corvi.ts");
    otherSource = join(tmp, "other-branch", "src");
    await mkdir(extensionsDir, { recursive: true });
    await mkdir(otherSource, { recursive: true });
    await writeFile(join(otherSource, "index.ts"), "// another branch\n");
    await writeFile(join(otherSource, "turns.ts"), "// another branch\n");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test(`install links ${name}'s extension into its plugin directory`, async () => {
    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(await readlink(entryLink)).toBe(join(sources[name], "index.ts"));
    // pi's loader resolves the entry's modules beside the file it loaded, so they are linked
    // along; opencode follows the link and finds them at the real file.
    if (isDirectoryLayout) {
      for (const file of ["agent-state.ts", "turns.ts"]) {
        expect(await readlink(join(installed, file))).toBe(join(sources[name], file));
      }
    }
  });

  test(`install removes the older installs' symlinks (${name})`, async () => {
    await symlink(join(otherSource, "index.ts"), legacyState);
    await symlink(join(otherSource, "index.ts"), legacyEntry);

    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(await readlink(entryLink)).toBe(join(sources[name], "index.ts"));
    // The old symlinks are gone: one would load the extension twice, and the other cannot
    // resolve its modules at all.
    expect(await lstat(legacyState).catch(() => undefined)).toBeUndefined();
    // opencode's install lives at that very path — its own link is the install, checked above.
    if (isDirectoryLayout) {
      expect(await lstat(legacyEntry).catch(() => undefined)).toBeUndefined();
    }
  });

  test(`install twice is a no-op the second time (${name})`, async () => {
    await run(`install:${name}`);
    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already installed");
    expect(await readlink(entryLink)).toBe(join(sources[name], "index.ts"));
  });

  test(`install repoints the links another branch made (${name})`, async () => {
    await otherInstall();

    const result = await run(`install:${name}`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("installed:");
    expect(await readlink(entryLink)).toBe(join(sources[name], "index.ts"));
    if (isDirectoryLayout) {
      expect(await readlink(join(installed, "turns.ts"))).toBe(join(sources[name], "turns.ts"));
    }
  });

  test(`uninstall removes the links another branch made (${name})`, async () => {
    await otherInstall();

    const result = await run(`uninstall:${name}`);

    expect(result.code).toBe(0);
    expect(await present()).toBe(false);
  });

  test(`uninstall removes a legacy symlink even with nothing else installed (${name})`, async () => {
    await symlink(join(otherSource, "index.ts"), legacyEntry);

    const result = await run(`uninstall:${name}`);

    expect(result.code).toBe(0);
    expect(await lstat(legacyEntry).catch(() => undefined)).toBeUndefined();
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

  if (isDirectoryLayout) {
    test(`install replaces a symlink at the install path (${name})`, async () => {
      await symlink(otherSource, installed);

      const result = await run(`install:${name}`);

      expect(result.code).toBe(0);
      expect(await readlink(entryLink)).toBe(join(sources[name], "index.ts"));
    });

    test(`uninstall leaves a real file inside the install directory alone (${name})`, async () => {
      await run(`install:${name}`);
      await writeFile(join(installed, "notes.txt"), "mine\n");

      const result = await run(`uninstall:${name}`);

      expect(result.code).toBe(0);
      // Our links are gone; the directory stays with the file that is not ours in it.
      expect(await readlink(entryLink).catch(() => undefined)).toBeUndefined();
      expect(await Bun.file(join(installed, "notes.txt")).text()).toBe("mine\n");
    });

    test(`install and uninstall refuse to touch a directory that is not ours (${name})`, async () => {
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "index.ts"), "// somebody's own extension\n");

      expect((await run(`install:${name}`)).code).toBe(1);
      expect((await run(`uninstall:${name}`)).code).toBe(1);
      expect(await Bun.file(join(installed, "index.ts")).text()).toBe(
        "// somebody's own extension\n",
      );
    });
  }
}

test("an unknown command prints the usage instead of guessing", async () => {
  expect((await runExtensionCommand("install")).code).toBe(1);
  expect((await runExtensionCommand("install:clang")).code).toBe(1);
  expect((await runExtensionCommand("remove:pi")).code).toBe(1);
  expect((await runExtensionCommand("install:pi:extra")).code).toBe(1);
  expect((await runExtensionCommand("")).code).toBe(1);
});
