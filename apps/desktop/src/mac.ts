/**
 * Installs the macOS app: an Electron bundle around the checkout.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *
 * The bundle is built by @electron/packager from a small directory holding the built main and
 * preload (apps/desktop/src/electron/build.ts). The checkout to serve is written into that app's
 * package.json — the `IWERoot` of the Swift app's Info.plist, in the one place both platforms
 * already look — so moving the repository is a reinstall, not a rebuild.
 *
 * Each window owns a server on a fresh port. Quitting stops that server, and reinstalling leaves
 * the app running on the installed build. See docs/manual/install.md.
 */
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { packager } from "@electron/packager";
import { sh } from "./exec.ts";
import { buildApp } from "./electron/build.ts";
import { installedElectron } from "./electron/binary.ts";
import { ID, PRODUCT } from "@corvi/configuration/node";

const NAME = PRODUCT;
/** The bundle identifier macOS keys permissions, notifications and Apple Events by. */
const BUNDLE_ID = "nl.wwbakker.corvi";
const bundle = (): string => join(homedir(), "Applications", `${NAME}.app`);

/** The Electron version this checkout has installed (apps/desktop/src/electron/binary.ts): the
 * bundle must wrap the same Electron the app runs from, so the version is the installed package's
 * own — not a manifest's dependency range, which the root one stopped carrying when `electron`
 * became a dependency of `@corvi/desktop`. */
async function electronVersion(): Promise<string> {
  const electron = installedElectron();
  if (electron === undefined) throw new Error("electron is not installed — run `bun install` first");
  const manifest = join(electron.dir, "package.json");
  const pkg = JSON.parse(await readFile(manifest, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`${manifest} declares no version`);
  return pkg.version;
}

/** Whatever this app needs the user to be told about the microphone: macOS refuses the request
 * outright, with no prompt, unless the bundle declares why — which is what made a voice
 * extension work in iTerm and fail silently in the old WKWebView app. */
const MIC_USAGE =
  `${NAME} asks for the microphone on behalf of whatever is running in its terminal — a voice extension, for instance — the same way any terminal app does.`;

/** The Dock icon, from the same SVG everything else is drawn from. Skipped when `rsvg-convert`
 * is missing: an app with the wrong icon still works, and refusing to build would be theatre. */
async function icon(into: string): Promise<string | null> {
  const iconset = join(into, `${ID}-icon.iconset`);
  await rm(iconset, { recursive: true, force: true });
  await sh(["mkdir", "-p", iconset]);
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
      if (r.code !== 0) return null;
    }
  }
  const icns = join(into, "icon.icns");
  const made = await sh(["iconutil", "-c", "icns", iconset, "-o", icns]);
  return made.code === 0 ? icns : null;
}

/** Whether the app is running, without asking macOS for permission to look. */
async function running(): Promise<boolean> {
  return (await sh(["pgrep", "-f", `${bundle()}/Contents/MacOS/`])).code === 0;
}

/**
 * Quit it, the way the Dock would: an Apple Event, so the app stops the server it started rather
 * than leaving it orphaned. Addressed by path, not by bundle identifier — a sandbox copy carries
 * another identifier, and `tell application id` goes to whichever bundle the system resolves.
 */
async function quit(): Promise<void> {
  await sh(["osascript", "-e", `tell application ${JSON.stringify(bundle())} to quit`]);
  for (let i = 0; i < 30 && (await running()); i++) await Bun.sleep(100);
  if (await running()) {
    await sh(["pkill", "-f", `${bundle()}/Contents/MacOS/`]);
    await Bun.sleep(300);
  }
}

async function install(root: string): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), `${ID}-app-source-`));
  const out = await mkdtemp(join(tmpdir(), `${ID}-app-build-`));
  try {
    await buildApp(source, root);
    const drawn = await icon(out);
    const [built] = await packager({
      dir: source,
      out,
      name: NAME,
      platform: "darwin",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      electronVersion: await electronVersion(),
      appBundleId: BUNDLE_ID,
      appVersion: "1.0.0",
      icon: drawn ?? undefined,
      extendInfo: { NSMicrophoneUsageDescription: MIC_USAGE },
      asar: true,
      overwrite: true,
    });
    if (!built) throw new Error("packager produced no app");
    // `packager` returns the output *directory* — `<name>-<platform>-<arch>`, holding the
    // bundle beside the licence files (its README: "Place `Foo Bar.app` in
    // `foobar/Foo Bar-darwin-arm64/`") — not the bundle itself. Copying that directory in as the
    // bundle nested one `.app` inside another, and macOS then refuses to open the outer one.
    const builtApp = join(built, `${NAME}.app`);
    if (!(await Bun.file(join(builtApp, "Contents", "Info.plist")).exists())) {
      throw new Error(`packager produced no app bundle in ${built}`);
    }

    // `open` on a running app only focuses it, so a rebuild would leave you looking at the old
    // one. Quit it first and start it afterwards — always, so an install leaves the client running
    // on the new build whether it happened to be open or not.
    const wasRunning = await running();
    if (wasRunning) await quit();

    await rm(bundle(), { recursive: true, force: true });
    // `verbatimSymlinks`, as the packager itself copies on EXDEV (platform.js): the frameworks
    // inside the bundle are held together by relative symlinks, and they must arrive unchanged.
    await cp(builtApp, bundle(), { recursive: true, verbatimSymlinks: true });
    // Finder caches bundles by path and date; touching it makes the new icon appear now.
    await sh(["touch", bundle()]);

    console.log(`installed: ${bundle()}`);
    console.log(`  serves:  ${root} on a fresh port at each launch (bun run dev keeps 4000)`);
    if (!drawn) console.log("  no icon: install librsvg for one (brew install librsvg)");
    await sh(["open", bundle()]);
    console.log(
      wasRunning
        ? "  restarted: it was running, so it is running again — on the new build"
        : "  started: the new build is up (drag it to the Dock to keep it there)",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

async function uninstall(): Promise<void> {
  if (!(await Bun.file(join(bundle(), "Contents", "Info.plist")).exists())) {
    console.log(`not installed: ${bundle()}`);
    return;
  }
  // Quit before removing: a running app whose bundle vanishes is a confusing thing to leave.
  if (await running()) await quit();
  await rm(bundle(), { recursive: true, force: true });
  console.log(`removed: ${bundle()}`);
}

export { install, uninstall };
