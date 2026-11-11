/**
 * Installs the app: a window onto Corvi, with the server behind it.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *   bun run app:run        — the same window straight from the checkout, nothing installed
 *   bun run electron:install — only the Electron binary the tests and the app run on
 *
 * The window is one Electron main process (apps/desktop/src/electron/main.ts) on both platforms. The
 * install builds it into a bundle: a macOS `.app` (apps/desktop/src/mac.ts) or, on Linux, a desktop
 * entry, an icon and a launcher (apps/desktop/src/linux.ts). Either way, clicking it starts the app's
 * own server — on a fresh port, picked at launch, so what it starts is always its own — and
 * shows the page. It is still only a window onto the same HTTP server any browser can open,
 * which is the point: the app is a convenience, not the product.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isLinux, isMac } from "@corvi/configuration/node";
import {
  electronBinaryVersion,
  electronPackageVersion,
  installedElectron,
  type ElectronPackage,
} from "./electron/binary.ts";
import { sh } from "./exec.ts";

const root = resolve(".");

/** Why the downloaded binary cannot serve this package, or `undefined` when it can. An upgrade
 * can leave the previous package's binary behind, and it starts the app and the tests on the
 * runtime that was just replaced. */
const electronMismatch = (electron: ElectronPackage): string | undefined => {
  const binary = electronBinaryVersion(electron);
  const expected = electronPackageVersion(electron);
  if (binary === expected) return undefined;
  return `the Electron binary is ${binary ?? "not downloaded"} but the electron package is ${expected ?? "of unknown version"}`;
};

/** The Electron binary this checkout installed, in the platform's own layout
 * (apps/desktop/src/electron/binary.ts). Electron downloads it lazily, so a fresh
 * `bun install` can leave it missing until first use; installing is where that belongs, with the
 * error visible, rather than at the first click of the app. */
async function ensureElectron(): Promise<void> {
  const electron = installedElectron();
  if (electron === undefined) {
    console.error("electron is not installed — run `bun install` first");
    process.exit(1);
  }
  const mismatch = electronMismatch(electron);
  if (existsSync(electron.binary) && mismatch === undefined) return;
  console.log(
    mismatch === undefined
      ? "downloading the Electron binary (first use of this checkout)…"
      : `${mismatch} — downloading the Electron binary again…`,
  );
  const downloaded = await sh(["bun", electron.installer]);
  if (downloaded.code !== 0 || !existsSync(electron.binary)) {
    console.error(downloaded.stderr || downloaded.stdout);
    console.error("could not download Electron — the app cannot start");
    process.exit(1);
  }
  const after = electronMismatch(electron);
  if (after !== undefined) {
    console.error(`${after} after downloading — the binary cannot run this package`);
    process.exit(1);
  }
}

/**
 * The app is only as good as its page, and the page is built ahead of time: a bundle that
 * cannot resolve `react` never gets written, and an app whose page was never built serves
 * nothing. Build it here instead, where the errors print. A fresh checkout without
 * `bun install` is the common way to get here, so that runs first.
 */
async function verify(): Promise<void> {
  const installed = await sh(["bun", "install"]);
  if (installed.code !== 0) {
    console.error(installed.stderr || installed.stdout);
    console.error("could not install dependencies — the page would not build, and the app would be a black window");
    process.exit(1);
  }
  await ensureElectron();
  // Verify the same build the release uses, not a separate bundler configuration.
  try {
    const { buildWeb } = await import("@corvi/web/build");
    await buildWeb();
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.error("the page does not build — the app would be a black window; fix the errors above and reinstall");
    process.exit(1);
  }
}

const command = process.argv[2];
const usage = (): void => {
  console.error("usage: bun apps/desktop/src/install.ts install|uninstall|run|electron");
  process.exit(1);
};

if (command === "install") {
  if (!isMac && !isLinux) {
    console.error("unsupported platform: the app is built for macOS and Linux");
    process.exit(1);
  }
  await verify();
  if (isMac) await (await import("./mac.ts")).install(root);
  else await (await import("./linux.ts")).install();
} else if (command === "uninstall") {
  if (isMac) await (await import("./mac.ts")).uninstall();
  else if (isLinux) await (await import("./linux.ts")).uninstall();
  else {
    console.error("unsupported platform: the app is built for macOS and Linux");
    process.exit(1);
  }
} else if (command === "run") {
  await (await import("./run.ts")).run();
} else if (command === "electron") {
  await ensureElectron();
} else usage();
