/**
 * Opens the app's window straight from the checkout — the same Electron main the installed
 * bundle runs, built on the spot.
 *
 *   bun run app:run
 *
 * Nothing is installed: the built app goes to `$XDG_STATE_HOME/iwe/app-dev` (or
 * `~/.local/state/iwe/app-dev`), and `IWE_APP_ROOT` tells it which checkout to serve. The server
 * it starts is the production one, on a fresh port, exactly like the installed app's. Handy for
 * trying a change to the host, and for `bun run app:drive` to open.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { electronBinary } from "./electron/binary.ts";
import { buildApp } from "./electron/build.ts";

/** Where the window built for development lives; `app:drive` builds to the same place. */
export const devAppDir = (): string =>
  process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "iwe", "app-dev")
    : join(homedir(), ".local", "state", "iwe", "app-dev");

export async function run(): Promise<void> {
  const root = resolve(".");
  const dir = devAppDir();
  await buildApp(dir, root);
  const electron = electronBinary(root);
  if (!existsSync(electron)) {
    console.error("no Electron binary — run `bun install` (app:install downloads it)");
    process.exit(1);
  }
  const child = Bun.spawn([electron, dir], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, IWE_APP_ROOT: root },
  });
  process.exit(await child.exited);
}
