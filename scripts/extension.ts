/**
 * Install or remove the pi extension that publishes agent state, by symlinking it into pi's
 * extension directory. A symlink rather than a copy: editing it here is editing the installed
 * one, and `/reload` in pi picks the change up.
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

/** What is at the path now: our link, someone else's, a real file, or nothing. */
async function occupant(path: string): Promise<"ours" | "link" | "file" | "none"> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return "none";
  if (!stat.isSymbolicLink()) return "file";
  return (await readlink(path).catch(() => "")) === SOURCE ? "ours" : "link";
}

async function install(): Promise<void> {
  const path = target();
  const found = await occupant(path);
  if (found === "ours") {
    console.log(`already installed: ${path}`);
    return;
  }
  // A file we did not put there is someone's work, and this is not the place to decide it is
  // obsolete.
  if (found !== "none") {
    console.error(`${path} exists and is not our symlink — remove it first`);
    process.exit(1);
  }
  await mkdir(join(path, ".."), { recursive: true });
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
  if (found !== "ours") {
    console.error(`${path} is not our symlink — leaving it alone`);
    process.exit(1);
  }
  await unlink(path);
  console.log(`removed: ${path}`);
  console.log("tmux keeps @agent on panes where pi is still running: tmux set -p -u @agent");
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "uninstall") await uninstall();
else {
  console.error("usage: bun scripts/extension.ts install|uninstall");
  process.exit(1);
}
