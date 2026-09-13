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
/** Where pi discovers global extensions; overridable for a test or a different install. */
const target = (): string =>
  join(process.env.PI_EXTENSIONS_DIR ?? join(homedir(), ".pi", "agent", "extensions"), "agent-state.ts");

/** What is at the path now: a symlink we may repoint, a real file, or nothing. */
async function occupant(path: string): Promise<"symlink" | "file" | "none"> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return "none";
  return stat.isSymbolicLink() ? "symlink" : "file";
}

async function install(): Promise<void> {
  const path = target();
  const found = await occupant(path);
  // A file someone put there is their work, and this is not the place to decide it is obsolete.
  if (found === "file") {
    console.error(`${path} exists and is not a symlink — remove it first`);
    process.exit(1);
  }
  if (found === "symlink" && (await readlink(path).catch(() => "")) === SOURCE) {
    console.log(`already installed: ${path}`);
    return;
  }
  await mkdir(join(path, ".."), { recursive: true });
  // Any symlink is repointed, not only one this checkout made: the extension may have been
  // installed from another branch or worktree, and pointing it here is what install means.
  if (found === "symlink") await unlink(path);
  await symlink(SOURCE, path);
  console.log(`installed: ${path} -> ${SOURCE}`);
  console.log("run /reload in pi, or start a new session, to load it");
}

async function uninstall(): Promise<void> {
  const path = target();
  const found = await occupant(path);
  if (found === "none") {
    console.log(`not installed: ${path}`);
    return;
  }
  if (found === "file") {
    console.error(`${path} is not a symlink — leaving it alone`);
    process.exit(1);
  }
  await unlink(path);
  console.log(`removed: ${path}`);
  console.log("tmux keeps @agent_status on panes where pi is still running: tmux set -p -u @agent_status");
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "uninstall") await uninstall();
else {
  console.error("usage: bun scripts/extension.ts install|uninstall");
  process.exit(1);
}
