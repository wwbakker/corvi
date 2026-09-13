/**
 * Installs the app: a window onto IWE, with the server behind it.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *   bun run app:run        — the same window straight from the checkout, nothing installed
 *
 * The window is one Electron main process (scripts/app/electron/main.ts) on both platforms. The
 * install builds it into a bundle: a macOS `.app` (scripts/app/mac.ts) or, on Linux, a desktop
 * entry, an icon and a launcher (scripts/app/linux.ts). Either way, clicking it starts the app's
 * own server — on a fresh port, picked at launch, so what it starts is always its own — and
 * shows the page. It is still only a window onto the same HTTP server any browser can open,
 * which is the point: the app is a convenience, not the product.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isLinux, isMac } from "../src/capabilities/os.ts";
import { electronBinary } from "./app/electron/binary.ts";
import { sh } from "./sh.ts";

const root = resolve(".");

/** The Electron binary this checkout installed, in the platform's own layout
 * (scripts/app/electron/binary.ts). Electron 44 downloads it lazily, so a fresh
 * `bun install` can leave it missing until first use; installing is where that belongs, with the
 * error visible, rather than at the first click of the app. */
const installedElectron = (): string => electronBinary(root);

async function ensureElectron(): Promise<void> {
  if (existsSync(installedElectron())) return;
  const installer = join(root, "node_modules", "electron", "install.js");
  if (!existsSync(installer)) {
    console.error("electron is not installed — run `bun install` first");
    process.exit(1);
  }
  console.log("downloading the Electron binary (first use of this checkout)…");
  const downloaded = await sh(["bun", installer]);
  if (downloaded.code !== 0 || !existsSync(installedElectron())) {
    console.error(downloaded.stderr || downloaded.stdout);
    console.error("could not download Electron — the app cannot start");
    process.exit(1);
  }
}

/**
 * The app is only as good as its page, and the page is built on demand: a bundle that cannot
 * resolve `react` comes back from the production server as an empty 200 — a black window, with
 * no error anywhere. Build it here instead, where the errors print. A fresh checkout without
 * `bun install` is the common way to get here, so that runs first; `bun build` then says
 * exactly which import did not resolve.
 */
async function verify(): Promise<void> {
  const installed = await sh(["bun", "install"]);
  if (installed.code !== 0) {
    console.error(installed.stderr || installed.stdout);
    console.error("could not install dependencies — the page would not build, and the app would be a black window");
    process.exit(1);
  }
  await ensureElectron();
  // The page build exactly as the server runs it (src/app-root/client.ts: esbuild inside the
  // process). Not `bun build src/app-root/index.html` any more: that path is gone with the Node
  // port (docs/decisions/node-server.md), and checking it here would pass while the real one was
  // broken.
  try {
    const { ensureClient } = await import("../src/app-root/client.ts");
    await ensureClient();
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    console.error("the page does not build — the app would be a black window; fix the errors above and reinstall");
    process.exit(1);
  }
}

const command = process.argv[2];
const usage = (): void => {
  console.error("usage: bun scripts/app.ts install|uninstall|run");
  process.exit(1);
};

if (command === "install") {
  if (!isMac && !isLinux) {
    console.error("unsupported platform: the app is built for macOS and Linux");
    process.exit(1);
  }
  await verify();
  if (isMac) await (await import("./app/mac.ts")).install(root);
  else await (await import("./app/linux.ts")).install();
} else if (command === "uninstall") {
  if (isMac) await (await import("./app/mac.ts")).uninstall();
  else if (isLinux) await (await import("./app/linux.ts")).uninstall();
  else {
    console.error("unsupported platform: the app is built for macOS and Linux");
    process.exit(1);
  }
} else if (command === "run") {
  await (await import("./app/run.ts")).run();
} else usage();
