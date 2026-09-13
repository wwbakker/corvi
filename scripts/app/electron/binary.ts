/**
 * Where Electron's own binary is, per platform.
 *
 * The npm package does not put the executable at one path: on Linux and Windows it is
 * `dist/electron(.exe)`, on macOS it is the bundle's `dist/Electron.app/Contents/MacOS/Electron`.
 * The package writes the real relative path into `path.txt` and resolves it the same way in its
 * own `index.js`, so that file is the source of truth here — a hardcoded `dist/electron` made
 * `app:install` fail on macOS with "could not download Electron", because the download had
 * already happened, just not where the check looked.
 *
 * Before the first download `path.txt` does not exist yet; the fallback is the platform's own
 * layout, so the check that triggers the download still looks in the right place afterwards.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const electronBinary = (root: string): string => {
  const electron = join(root, "node_modules", "electron");
  const recorded = existsSync(join(electron, "path.txt"))
    ? readFileSync(join(electron, "path.txt"), "utf8").trim()
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : process.platform === "win32"
        ? "electron.exe"
        : "electron";
  return join(electron, "dist", recorded);
};
