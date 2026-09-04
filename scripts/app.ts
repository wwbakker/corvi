/**
 * Builds the macOS app: a window onto IWE, with the server inside it.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *
 * Clicking it starts the server if nothing is listening and shows the page; quitting it stops the
 * server it started (a server you started yourself, in a terminal, is left alone). The window is
 * a WKWebView, so the title bar is the same colour as the page and there is no browser around it.
 *
 * AppKit and WebKit are in the system: this costs a `swiftc` at install time and nothing at
 * runtime. No Electron, no Rust, no second browser — and the app is still only a window onto the
 * same HTTP server any browser can open.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sh } from "../src/sh.ts";

/** What it is called in the Dock, in the menu bar and in its own title bar. `IWE` is what the
 * repository is called; this is an application, and applications have names. */
const NAME = "Integrated Work Environment";
/** The file inside the bundle, which is not shown anywhere and is easier without spaces. */
const BINARY = "IWE";
/** Bundles the older, abbreviated installs left behind. */
const OLD = ["IWE"];
const root = resolve(".");
/**
 * The app's own port, so it never meets `bun run dev` on 4000.
 *
 * They were the same port and the app attached to whatever was listening, which meant a dev
 * server left running from last week silently became "the app" — with last week's code, and no
 * way to tell from the window. Five digits because nobody types this one: it is reached by
 * clicking the icon.
 */
const port = process.env.IWE_PORT ?? "43117";
const bundle = (): string => join(homedir(), "Applications", `${NAME}.app`);

const plist = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>dev.iwe.app</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${BINARY}</string>
  <key>CFBundleIconFile</key><string>${BINARY}</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- Where the code is and which port it serves on, so the binary need not be rebuilt for
       either. Read by the app at launch. -->
  <key>IWERoot</key><string>${root}</string>
  <key>IWEPort</key><string>${port}</string>
  <!-- The server is on plain HTTP on the loopback address, which is the only thing it listens on. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;

/** The Dock icon, from the same SVG everything else is drawn from. Skipped when `rsvg-convert`
 * is missing: an app with the wrong icon still works, and refusing to build would be theatre. */
async function icon(into: string): Promise<boolean> {
  const iconset = "/tmp/iwe-icon.iconset";
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [
      [1, ""],
      [2, "@2x"],
    ] as const) {
      const r = await sh([
        "rsvg-convert",
        "-w",
        String(size * scale),
        "-h",
        String(size * scale),
        "assets/icon.svg",
        "-o",
        join(iconset, `icon_${size}x${size}${suffix}.png`),
      ]);
      if (r.code !== 0) return false;
    }
  }
  const made = await sh(["iconutil", "-c", "icns", iconset, "-o", join(into, `${BINARY}.icns`)]);
  await rm(iconset, { recursive: true, force: true });
  return made.code === 0;
}

/** Whether the app is running, without asking macOS for permission to look. */
async function running(): Promise<boolean> {
  return (await sh(["pgrep", "-f", `${bundle()}/Contents/MacOS/${BINARY}`])).code === 0;
}

/**
 * Quit it, the way the Dock would: an Apple Event, so the app stops the server it started rather
 * than leaving it orphaned. A signal would skip that, so it is only the fallback.
 *
 * Addressed by path, not by bundle identifier. A copy of the app made to try something against a
 * scratch server carries the same identifier, and `tell application id` goes to whichever one the
 * system resolves — which is how quitting a test copy quit the real app instead. A path is
 * exactly one bundle.
 */
async function quit(): Promise<void> {
  await sh(["osascript", "-e", `tell application ${JSON.stringify(bundle())} to quit`]);
  for (let i = 0; i < 30 && (await running()); i++) await Bun.sleep(100);
  if (await running()) {
    await sh(["pkill", "-f", `${bundle()}/Contents/MacOS/${BINARY}`]);
    await Bun.sleep(300);
  }
}

async function install(): Promise<void> {
  const app = bundle();
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });

  // Built to one side first: a failed compile should leave the app you have alone, and it is
  // still running at this point.
  const built_binary = "/tmp/iwe-app-build";
  const built = await sh([
    "swiftc",
    "-O",
    "scripts/app/IWE.swift",
    "-o",
    built_binary,
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
  ]);
  if (built.code !== 0) {
    console.error(built.stderr || built.stdout);
    console.error("could not build the app — are the Xcode command line tools installed?");
    process.exit(1);
  }

  // `open` on a running app only focuses it, so a rebuild would leave you looking at the old
  // one. Quit it first and put it back afterwards, in the state you had it.
  const wasRunning = await running();
  if (wasRunning) await quit();

  await sh(["mv", built_binary, join(macos, BINARY)]);
  await chmod(join(macos, BINARY), 0o755);

  await writeFile(join(app, "Contents", "Info.plist"), plist());
  const drawn = await icon(resources);
  // An install under the old, abbreviated name would otherwise sit in the Dock next to this one,
  // pointing at the same repository.
  for (const old of OLD) await rm(join(homedir(), "Applications", `${old}.app`), { recursive: true, force: true });
  // Finder caches bundles by path and date; touching it makes the new icon appear now.
  await sh(["touch", app]);

  console.log(`installed: ${app}`);
  console.log(`  serves:  ${root} on port ${port} (bun run dev keeps 4000)`);
  if (!drawn) console.log("  no icon: install librsvg for one (brew install librsvg)");
  if (wasRunning) {
    await sh(["open", app]);
    console.log("  restarted: it was running, so it is running again — on the new build");
  } else {
    console.log("drag it to the Dock; it starts the server if nothing is listening");
  }
}

async function uninstall(): Promise<void> {
  const app = bundle();
  if (!(await Bun.file(join(app, "Contents", "Info.plist")).exists())) {
    console.log(`not installed: ${app}`);
    return;
  }
  // Quit before removing: a running app whose bundle vanishes is a confusing thing to leave.
  if (await running()) await quit();
  await rm(app, { recursive: true, force: true });
  for (const old of OLD) await rm(join(homedir(), "Applications", `${old}.app`), { recursive: true, force: true });
  console.log(`removed: ${app}`);
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "uninstall") await uninstall();
else {
  console.error("usage: bun scripts/app.ts install|uninstall");
  process.exit(1);
}
