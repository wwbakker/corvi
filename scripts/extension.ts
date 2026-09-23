/**
 * Install or remove the agent-state reporters — the writers of Corvi's agent protocol (see
 * docs/manual/terminals.md) — by symlinking each one into its agent's plugin directory. A symlink
 * rather than a copy: editing it here is editing the installed one, and the agent picks the change
 * up (pi: `/reload`). The link is repointed whatever checkout made it before, so installing from
 * another branch or worktree just moves it; a real file at the path is left alone.
 *
 *   bun run extension:install:pi         bun run extension:uninstall:pi
 *   bun run extension:install:opencode   bun run extension:uninstall:opencode
 */

import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** What a command produced: the process's exit code and the text it would have printed. Returned
 * rather than printed so the commands are callable in a test without a spawned runtime. */
export type ExtensionCommandResult = { code: number; stdout: string; stderr: string };

/** One agent to install for: its reporter in this checkout, where its plugins are discovered, and
 * what the user must do to get the agent to load it. */
export type AgentTarget = {
  readonly name: "pi" | "opencode";
  /** The reporter file in this checkout, resolved against the working directory like the
   * commands themselves. */
  readonly source: string;
  /** Where the agent discovers plugins; overridable for a test or a different install. */
  readonly directory: () => string;
  /** What to tell the user so the agent loads (or reloads) it. */
  readonly reloadHint: string;
};

export const targets: Readonly<Record<"pi" | "opencode", AgentTarget>> = {
  pi: {
    name: "pi",
    source: resolve("integrations/pi/src/agent-state.ts"),
    directory: (): string => process.env.PI_EXTENSIONS_DIR ?? join(homedir(), ".pi", "agent", "extensions"),
    reloadHint: "run /reload in pi, or start a new session, to load it",
  },
  opencode: {
    name: "opencode",
    source: resolve("integrations/opencode/src/agent-state.ts"),
    directory: (): string =>
      process.env.OPENCODE_PLUGIN_DIR ?? join(homedir(), ".config", "opencode", "plugin"),
    reloadHint: "restart opencode to load it",
  },
};

export type AgentTargetName = keyof typeof targets;

/** What is at the path now: a symlink we may repoint, a real file, or nothing. */
async function occupant(path: string): Promise<"symlink" | "file" | "none"> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return "none";
  return stat.isSymbolicLink() ? "symlink" : "file";
}

export async function install(
  name: AgentTargetName,
  directory = targets[name].directory(),
): Promise<ExtensionCommandResult> {
  const target = targets[name];
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
  if (found === "symlink" && (await readlink(path).catch(() => "")) === target.source) {
    return { code: 0, stdout: `already installed: ${path}\n`, stderr: "" };
  }
  await mkdir(directory, { recursive: true });
  // Any symlink is repointed, not only one this checkout made: the reporter may have been
  // installed from another branch or worktree, and pointing it here is what install means.
  if (found === "symlink") await unlink(path);
  await symlink(target.source, path);
  return {
    code: 0,
    stdout: `installed: ${path} -> ${target.source}\n${target.reloadHint}\n`,
    stderr: "",
  };
}

export async function uninstall(
  name: AgentTargetName,
  directory = targets[name].directory(),
): Promise<ExtensionCommandResult> {
  const target = targets[name];
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
    stdout: `removed: ${path}\ntmux keeps @agent_status on panes where ${target.name} is still running: tmux set -p -u @agent_status\n`,
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
