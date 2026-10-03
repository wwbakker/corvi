/**
 * Install or remove the Corvi extensions — the agent-state reporters and the subagent relays
 * (see docs/manual/terminals.md) — by symlinking their source into the agent's plugin directory.
 * Symlinks rather than copies: editing it here is editing the installed one, and the agent picks
 * the change up (pi: `/reload`).
 *
 * The shape follows each agent's loader, which is why the two differ. pi resolves a module's
 * imports beside the file it loaded, so the extension — entry `index.ts` plus its modules —
 * installs as a directory of links. opencode follows the link to the entry and resolves its
 * modules beside the real file, so one link to the entry is the whole install.
 *
 * Links are repointed whatever checkout made them, so installing from another branch or worktree
 * just moves them; older shapes are removed on install so nothing loads twice or not at all; a
 * real file at the destination is somebody else's and is left alone.
 *
 *   bun run extension:install:pi         bun run extension:uninstall:pi
 *   bun run extension:install:opencode   bun run extension:uninstall:opencode
 */

import { lstat, mkdir, readdir, readlink, rmdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** What a command produced: the process's exit code and the text it would have printed. Returned
 * rather than printed so the commands are callable in a test without a spawned runtime. */
export type ExtensionCommandResult = { code: number; stdout: string; stderr: string };

/** One agent to install for: its extension in this checkout, where its plugins are discovered,
 * the shape its loader needs, and what the user must do to get the agent to load it. */
export type AgentTarget = {
  readonly name: "pi" | "opencode";
  /** The extension's source directory in this checkout: its `index.ts` is the entry and every
   * `*.ts` beside it is a module of it, resolved against the working directory like the commands
   * themselves. */
  readonly source: string;
  /** What the install is called in the agent's plugin directory. */
  readonly installed: string;
  /** `directory` when the loader resolves a module's imports beside the file it loaded — the
   * modules must then sit beside the entry in the plugin directory — and `file` when it follows
   * the link to the entry and finds them at the real file. */
  readonly layout: "directory" | "file";
  /** What older Corvis installed instead: a symlink of one is removed on install, so the agent
   * does not load a broken or doubled extension. */
  readonly legacyFiles: readonly string[];
  /** Where the agent discovers plugins; overridable for a test or a different install. */
  readonly directory: () => string;
  /** What to tell the user so the agent loads (or reloads) it. */
  readonly reloadHint: string;
};

export const targets: Readonly<Record<"pi" | "opencode", AgentTarget>> = {
  pi: {
    name: "pi",
    source: resolve("integrations/pi/src"),
    installed: "corvi",
    layout: "directory",
    legacyFiles: ["agent-state.ts", "corvi.ts"],
    directory: (): string => process.env.PI_EXTENSIONS_DIR ?? join(homedir(), ".pi", "agent", "extensions"),
    reloadHint: "run /reload in pi, or start a new session, to load it",
  },
  opencode: {
    name: "opencode",
    source: resolve("integrations/opencode/src"),
    installed: "corvi.ts",
    layout: "file",
    legacyFiles: ["agent-state.ts"],
    directory: (): string =>
      process.env.OPENCODE_PLUGIN_DIR ?? join(homedir(), ".config", "opencode", "plugin"),
    reloadHint: "restart opencode to load it",
  },
};

export type AgentTargetName = keyof typeof targets;

/** The entry file: the one both loaders look for in their own shape. */
const ENTRY = "index.ts";

/** What is at the path now: a symlink we may repoint, a directory, a real file, or nothing. */
async function occupant(path: string): Promise<"symlink" | "dir" | "file" | "none"> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return "none";
  if (stat.isSymbolicLink()) return "symlink";
  return stat.isDirectory() ? "dir" : "file";
}

/** A directory is ours when its entry is one of our symlinks; a hand-made directory has a real
 * `index.ts` (or none at all) and is somebody else's. */
const isOurs = async (path: string): Promise<boolean> =>
  (await occupant(join(path, ENTRY))) === "symlink";

/** The source files that make up the extension: the entry and every module beside it. */
const sourceFiles = async (target: AgentTarget): Promise<string[]> =>
  (await readdir(target.source)).filter((name) => name.endsWith(".ts")).sort();

/** The module directories that must sit beside the entry, because the loader resolves imports
 * against the install directory: the node adapter, which holds the extension's one OS concern. */
const sourceDirs = async (target: AgentTarget): Promise<string[]> => {
  const dirs: string[] = [];
  for (const name of (await readdir(target.source)).sort()) {
    const stat = await lstat(join(target.source, name)).catch(() => undefined);
    if (stat?.isDirectory() === true) dirs.push(name);
  }
  return dirs;
};

/** Every symlink in an install directory, by name. Real files in it are not ours to report. */
const linksOf = async (path: string): Promise<Map<string, string>> => {
  const links = new Map<string, string>();
  for (const name of (await readdir(path)).sort()) {
    const entry = join(path, name);
    if ((await occupant(entry)) === "symlink") {
      links.set(name, (await readlink(entry).catch(() => "")) ?? "");
    }
  }
  return links;
};

/** Point one install directory's symlinks at this checkout's source files, whatever they named
 * before: old links go first so no stale module can shadow a renamed one. */
const linkAll = async (path: string, target: AgentTarget): Promise<void> => {
  for (const name of (await linksOf(path)).keys()) await unlink(join(path, name));
  for (const name of await sourceFiles(target)) {
    await symlink(join(target.source, name), join(path, name));
  }
  for (const name of await sourceDirs(target)) {
    await symlink(join(target.source, name), join(path, name));
  }
};

export async function install(
  name: AgentTargetName,
  directory = targets[name].directory(),
): Promise<ExtensionCommandResult> {
  const target = targets[name];
  const path = join(directory, target.installed);
  const found = await occupant(path);
  // A file or directory someone made is their work, and this is not the place to decide it is
  // obsolete. A directory whose entry is one of our symlinks is an install — ours or another
  // checkout's — and installing means pointing it here.
  if (found === "file" || (found === "dir" && !(await isOurs(path)))) {
    return {
      code: 1,
      stdout: "",
      stderr: `${path} exists and is not ours — remove it first\n`,
    };
  }
  await removeLegacy(directory, target);
  const wanted = join(target.source, ENTRY);
  if (target.layout === "file") {
    if (found === "symlink" && (await readlink(path).catch(() => "")) === wanted) {
      return { code: 0, stdout: `already installed: ${path}\n`, stderr: "" };
    }
    if (found === "symlink") await unlink(path);
    await symlink(wanted, path);
    return {
      code: 0,
      stdout: `installed: ${path} -> ${wanted}\n${target.reloadHint}\n`,
      stderr: "",
    };
  }
  if (found === "dir") {
    const have = await linksOf(path);
    const want = new Map<string, string>([
      ...(await sourceFiles(target)).map((file) => [file, join(target.source, file)] as const),
      ...(await sourceDirs(target)).map((dir) => [dir, join(target.source, dir)] as const),
    ]);
    const same =
      have.size === want.size && [...want].every(([file, source]) => have.get(file) === source);
    if (same) return { code: 0, stdout: `already installed: ${path}\n`, stderr: "" };
  }
  if (found === "symlink") await unlink(path);
  if (found !== "dir") await mkdir(path, { recursive: true });
  await linkAll(path, target);
  return {
    code: 0,
    stdout: `installed: ${path} -> ${target.source}\n${target.reloadHint}\n`,
    stderr: "",
  };
}

/** Remove the symlinks an older Corvi left at the top level, if any are there: loading both
 * shapes would run the reporter twice, and one old shape cannot even load. A real file at the
 * path is somebody else's and stays. */
async function removeLegacy(directory: string, target: AgentTarget): Promise<void> {
  for (const legacy of target.legacyFiles) {
    const path = join(directory, legacy);
    if ((await occupant(path)) === "symlink") await unlink(path);
  }
}

export async function uninstall(
  name: AgentTargetName,
  directory = targets[name].directory(),
): Promise<ExtensionCommandResult> {
  const target = targets[name];
  const path = join(directory, target.installed);
  // Legacy symlinks left by older Corvis are removed even when the current install is not
  // there, so uninstalling a migrated install actually unloads the extension.
  await removeLegacy(directory, target);
  const found = await occupant(path);
  if (found === "none") return { code: 0, stdout: `not installed: ${path}\n`, stderr: "" };
  if (found === "file" || (found === "dir" && !(await isOurs(path)))) {
    return {
      code: 1,
      stdout: "",
      stderr: `${path} is not ours — leaving it alone\n`,
    };
  }
  if (found === "symlink") {
    await unlink(path);
  } else {
    // Only our links go; the directory itself goes when nothing real remains in it.
    for (const name of (await linksOf(path)).keys()) await unlink(join(path, name));
    await rmdir(path).catch(() => undefined);
  }
  return {
    code: 0,
    stdout: `removed: ${path}\n`,
    stderr: "",
  };
}

/** Dispatch one command by name. `directories` overrides where each agent's plugins live, for a
 * test or a non-standard install. */
export const runExtensionCommand = async (
  command: string,
  directories?: Partial<Record<AgentTargetName, string>>,
): Promise<ExtensionCommandResult> => {
  const [verb, name, ...rest] = command.split(":");
  const target = name === "pi" || name === "opencode" ? targets[name] : undefined;
  if (rest.length > 0 || !target || (verb !== "install" && verb !== "uninstall")) {
    return {
      code: 1,
      stdout: "",
      stderr: "usage: bun scripts/extension.ts install:pi|uninstall:pi|install:opencode|uninstall:opencode\n",
    };
  }
  const directory = directories?.[target.name] ?? target.directory();
  return verb === "install" ? install(target.name, directory) : uninstall(target.name, directory);
};

if (import.meta.main) {
  const result = await runExtensionCommand(process.argv[2] ?? "");
  if (result.stdout) console.log(result.stdout.replace(/\n$/, ""));
  if (result.stderr) console.error(result.stderr.replace(/\n$/, ""));
  process.exit(result.code);
}
