/**
 * Where Electron's own package is, and where the binary lives inside it, per platform.
 *
 * The npm package does not put the executable at one path: on Linux and Windows it is
 * `dist/electron(.exe)`, on macOS it is the bundle's `dist/Electron.app/Contents/MacOS/Electron`.
 * The package writes the real relative path into `path.txt` and resolves it the same way in its
 * own `index.js`, so that file is the source of truth here — a hardcoded `dist/electron` made
 * `app:install` fail on macOS with "could not download Electron", because the download had
 * already happened, just not where the check looked.
 *
 * The package's own directory is not `<checkout>/node_modules/electron` either: `electron` is a
 * dependency of `@corvi/desktop`, and bun's isolated layout keeps it in
 * `apps/desktop/node_modules` instead of hoisting it to the checkout root. Looking at the root
 * made `app:install` answer "electron is not installed — run `bun install` first" straight after a
 * successful `bun install`, so the lookup walks this module's own `node_modules` ancestors — Node's
 * resolution order — and reports the path in the checkout's tree (the `apps/desktop/node_modules/electron`
 * symlink, not bun's store behind it), which is the path that stays valid across installs.
 *
 * Before the first download `path.txt` does not exist yet; the fallback is the platform's own
 * layout, so the check that triggers the download still looks in the right place afterwards.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout's installed `electron` package and the paths inside it used from outside it.
 * `undefined` means `bun install` has not put the package in this checkout at all — a package
 * without its downloaded binary is not `undefined`, that binary is what `installer` produces. */
export type ElectronPackage = {
  /** The package's own directory, wherever in the checkout it is installed. */
  readonly dir: string;
  /** The Electron executable inside it, in the platform's own layout. */
  readonly binary: string;
  /** `install.js`, which downloads the binary into `dist` on first use. */
  readonly installer: string;
};

/** The nearest `node_modules/electron` above this module, following Node's own resolution order
 * (see the module comment for why not `require.resolve`, which realpaths into bun's store). */
const electronDir = (): string | undefined => {
  for (let dir: string = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "electron");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
  }
};

export const installedElectron = (): ElectronPackage | undefined => {
  const dir = electronDir();
  if (dir === undefined) return undefined;
  const recorded = existsSync(join(dir, "path.txt"))
    ? readFileSync(join(dir, "path.txt"), "utf8").trim()
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : process.platform === "win32"
        ? "electron.exe"
        : "electron";
  return {
    dir,
    binary: join(dir, "dist", recorded),
    installer: join(dir, "install.js"),
  };
};

/** The Electron executable of this checkout, or `undefined` when the `electron` package is not
 * installed here. The binary itself may still be missing: `app:install` downloads it. */
export const electronBinary = (): string | undefined => installedElectron()?.binary;
