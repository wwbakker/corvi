/**
 * Installs the app: a window onto IWE, with the server behind it.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *
 * macOS builds the Swift/WKWebView bundle (below). Linux installs a desktop
 * entry, an icon and a launcher around the WebKitGTK window in
 * scripts/app/linux-window (scripts/app/linux.ts). Either way: clicking it
 * starts the app's own server — on a fresh port, picked at launch, so what it
 * starts is always its own — and shows the page; AppKit and WebKit/GTK are in
 * the system, so this costs a `swiftc` on macOS and nothing at all on Linux. No Electron, no Rust, no second browser — the app is only
 * a window onto the same HTTP server any browser can open.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isLinux, isMac } from "../src/platform.ts";
import { sh } from "../src/sh.ts";

/** What it is called in the Dock, in the menu bar and in its own title bar. `IWE` is what the
 * repository is called; this is an application, and applications have names. */
const NAME = "Integrated Work Environment";
/** The file inside the bundle, which is not shown anywhere and is easier without spaces. */
const BINARY = "IWE";
/** Bundles the older, abbreviated installs left behind. */
const OLD = ["IWE"];
const root = resolve(".");
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
  <!-- Where the code is, so the binary need not be rebuilt for it. Read by the app at launch.
       The port is not here any more: the app picks a fresh one at each launch, so the server
       behind the window is always one that window started — nothing stale to attach to. -->
  <key>IWERoot</key><string>${root}</string>
  <!-- The server is on plain HTTP on the loopback address, which is the only thing it listens on. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <!-- Without this string macOS refuses the microphone to anything in this app's process tree
       outright — no prompt, just a denial — which is what made a voice extension work in iTerm
       (which declares its own) and fail silently in here: the terminal is ttyd, tmux and your
       shell, all spawned from this app, so this app is who the permission is asked of. -->
  <key>NSMicrophoneUsageDescription</key><string>${NAME} asks for the microphone on behalf of whatever is running in its terminal — a voice extension, for instance — the same way any terminal app does.</string>
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
  const out = "/tmp/iwe-build-check";
  const built = await sh(["bun", "build", "src/web/index.html", "--outdir", out, "--production"]);
  await rm(out, { recursive: true, force: true });
  if (built.code !== 0) {
    console.error(built.stderr || built.stdout);
    console.error("the page does not build — the app would be a black window; fix the errors above and reinstall");
    process.exit(1);
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
  console.log(`  serves:  ${root} on a fresh port at each launch (bun run dev keeps 4000)`);
  if (!drawn) console.log("  no icon: install librsvg for one (brew install librsvg)");
  if (wasRunning) {
    await sh(["open", app]);
    console.log("  restarted: it was running, so it is running again — on the new build");
  } else {
    console.log("drag it to the Dock; it starts its own server on a fresh port");
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
const usage = () => {
  console.error("usage: bun scripts/app.ts install|uninstall");
  process.exit(1);
};

if (isMac) {
  if (command === "install") {
    await verify();
    await install();
  } else if (command === "uninstall") await uninstall();
  else usage();
} else if (isLinux) {
  const linux = await import("./app/linux.ts");
  if (command === "install") {
    await verify();
    await linux.install();
  } else if (command === "uninstall") await linux.uninstall();
  else usage();
} else {
  console.error("unsupported platform: the app is built for macOS and Linux");
  process.exit(1);
}
