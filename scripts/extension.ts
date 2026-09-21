/**
 * Install or remove the pi extension that publishes agent state, by symlinking it into pi's
 * extension directory. A symlink rather than a copy: editing it here is editing the installed
 * one, and `/reload` in pi picks the change up. The link is repointed whatever checkout made it
 * before, so installing from another branch or worktree just moves it; a real file at the path
 * is left alone.
 *
 *   bun run extension:install
 *   bun run extension:uninstall
 */

import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SOURCE = resolve("pi/agent-state.ts");

/** What a command produced: the process's exit code and the text it would have printed. Returned
 * rather than printed so the commands are callable in a test without a spawned runtime. */
export type ExtensionCommandResult = { code: number; stdout: string; stderr: string };

/** Where pi discovers global extensions; overridable for a test or a different install. */
export const extensionsDirectory = (): string =>
  process.env.PI_EXTENSIONS_DIR ?? join(homedir(), ".pi", "agent", "extensions");

/** What is at the path now: a symlink we may repoint, a real file, or nothing. */
async function occupant(path: string): Promise<"symlink" | "file" | "none"> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return "none";
  return stat.isSymbolicLink() ? "symlink" : "file";
}

export async function install(directory = extensionsDirectory()): Promise<ExtensionCommandResult> {
  const path = join(directory, "agent-state.ts");
  const found = await occupant(path);
  // A file someone put there is their work, and this is not the place to decide it is obsolete.
  if (found === "file") {
    return {
      code: 1,
      stdout: "",
      stderr: `${path} exists and is not a symlink — remove it first\n`,
    };
  }
  if (found === "symlink" && (await readlink(path).catch(() => "")) === SOURCE) {
    return { code: 0, stdout: `already installed: ${path}\n`, stderr: "" };
  }
  await mkdir(directory, { recursive: true });
  // Any symlink is repointed, not only one this checkout made: the extension may have been
  // installed from another branch or worktree, and pointing it here is what install means.
  if (found === "symlink") await unlink(path);
  await symlink(SOURCE, path);
  return {
    code: 0,
    stdout: `installed: ${path} -> ${SOURCE}\nrun /reload in pi, or start a new session, to load it\n`,
    stderr: "",
  };
}

export async function uninstall(directory = extensionsDirectory()): Promise<ExtensionCommandResult> {
  const path = join(directory, "agent-state.ts");
  const found = await occupant(path);
  if (found === "none") return { code: 0, stdout: `not installed: ${path}\n`, stderr: "" };
  if (found === "file") {
    return {
      code: 1,
      stdout: "",
      stderr: `${path} is not a symlink — leaving it alone\n`,
    };
  }
  await unlink(path);
  return {
    code: 0,
    stdout: `removed: ${path}\ntmux keeps @agent_status on panes where pi is still running: tmux set -p -u @agent_status\n`,
    stderr: "",
  };
}

/** Dispatch one command by name. */
export const runExtensionCommand = async (
  command: string,
  directory = extensionsDirectory(),
): Promise<ExtensionCommandResult> =>
  command === "install"
    ? install(directory)
    : command === "uninstall"
      ? uninstall(directory)
      : { code: 1, stdout: "", stderr: "usage: bun scripts/extension.ts install|uninstall\n" };

if (import.meta.main) {
  const result = await runExtensionCommand(process.argv[2] ?? "");
  if (result.stdout) console.log(result.stdout.replace(/\n$/, ""));
  if (result.stderr) console.error(result.stderr.replace(/\n$/, ""));
  process.exit(result.code);
}
