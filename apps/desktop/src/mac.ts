/**
 * Installs the macOS app: an Electron bundle around the checkout.
 *
 *   bun run app:install
 *   bun run app:uninstall
 *
 * The bundle is built by @electron/packager from a small directory holding the built main and
 * preload (apps/desktop/src/electron/build.ts). The checkout to serve is written into that app's
 * package.json — the old Swift app's Info.plist root key, in the one place both platforms
 * already look — so moving the repository is a reinstall, not a rebuild.
 *
 * Two ways to replace a bundle, and the difference is who asked (see `InstallTarget`). From a
 * terminal the installer is not the app, so it quits the installed app first and opens the new
 * build afterwards. From the app itself — the update's last step — quitting would signal the
 * process group that step runs in, so the bundle is replaced under the running app instead and the
 * app's own restart loads it. Either way the terminal host is not the app: it outlives both, so the
 * shells survive a reinstall. See docs/manual/install.md.
 */
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { packager } from "@electron/packager";
import { isAppProcess } from "./app-process.ts";
import { sh } from "./exec.ts";
import { buildApp } from "./electron/build.ts";
import { installedElectron } from "./electron/binary.ts";
import { ID, PRODUCT } from "@corvi/configuration/node";

const NAME = PRODUCT;
/** The bundle identifier macOS keys permissions, notifications and Apple Events by. */
const BUNDLE_ID = "nl.wwbakker.corvi";

/** What a reinstall replaces, and whether the app comes back on its own. */
export type InstallTarget = {
  /** The bundle to replace: the installed one, or the copy the app is running from. */
  readonly bundle: string;
  /** Quit the installed app first and open the new build afterwards — a terminal run. False when
   * the app asked for itself: it is running, and its **Restart now** loads the new build. */
  readonly relaunch: boolean;
};

/** The bundle a terminal run installs. */
export const installedBundle = (): string => join(homedir(), "Applications", `${NAME}.app`);

/** A bundle's name — its directory's, which is also what the packager names the executable inside
 * it: a copy that renamed itself (`scripts/sandbox.ts`) keeps its name across a reinstall. */
const nameOf = (bundle: string): string => basename(bundle, ".app");

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
const micUsage = (name: string): string =>
  `${name} asks for the microphone on behalf of whatever is running in its terminal — a voice extension, for instance — the same way any terminal app does.`;

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

/** The bundle's executable. The app's server and terminal host run on it as well, so it identifies
 * a family of processes rather than the app (see `app-process.ts`). */
const executableOf = (bundle: string): string => join(bundle, "Contents", "MacOS", nameOf(bundle));

/** The app's own processes, by pid: the bundle's executable, and flags at most. */
async function appPids(bundle: string): Promise<number[]> {
  const executable = executableOf(bundle);
  const listed = await sh(["ps", "-axo", "pid=,command="]);
  if (listed.code !== 0) return [];
  return listed.stdout.split("\n").flatMap((line) => {
    const found = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (found === null) return [];
    const pid = Number(found[1]);
    return Number.isInteger(pid) && isAppProcess(found[2] ?? "", executable) ? [pid] : [];
  });
}

/** Whether the app is running, without asking macOS for permission to look. A server or a terminal
 * host that outlived the last window shares the executable but is not a running app, and must not
 * make one look running. */
async function running(bundle: string): Promise<boolean> {
  return (await appPids(bundle)).length > 0;
}

/**
 * Quit it, the way the Dock would: an Apple Event, so the app stops the server it started rather
 * than leaving it orphaned. Addressed by path, not by bundle identifier — a sandbox copy carries
 * another identifier, and `tell application id` goes to whichever bundle the system resolves.
 *
 * The fallback signals the app's own pids only. Its server and the terminal host share the bundle's
 * executable, and the host is meant to outlive the app: matching that path killed every terminal
 * the user had on each reinstall.
 */
async function quit(bundle: string): Promise<void> {
  await sh(["osascript", "-e", `tell application ${JSON.stringify(bundle)} to quit`]);
  for (let i = 0; i < 30 && (await running(bundle)); i++) await Bun.sleep(100);
  const left = await appPids(bundle);
  if (left.length === 0) return;
  await sh(["kill", "-TERM", ...left.map(String)]);
  for (let i = 0; i < 10 && (await running(bundle)); i++) await Bun.sleep(100);
  const stubborn = await appPids(bundle);
  if (stubborn.length > 0) await sh(["kill", "-KILL", ...stubborn.map(String)]);
}

/** The identifier a reinstall must not change. macOS keys permissions, notifications and Apple
 * Events by it, so a copy that carries its own — `scripts/sandbox.ts` gives one to keep the two
 * apart — would silently become the real app again, and every reinstall would keep writing the
 * same identifier into it. */
async function identifierOf(bundle: string): Promise<string> {
  const plist = join(bundle, "Contents", "Info.plist");
  if (!(await Bun.file(plist).exists())) return BUNDLE_ID;
  const read = await sh(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", plist]);
  const identifier = read.code === 0 ? read.stdout.trim() : "";
  return identifier || BUNDLE_ID;
}

async function install(root: string, target: InstallTarget): Promise<void> {
  const name = nameOf(target.bundle);
  const source = await mkdtemp(join(tmpdir(), `${ID}-app-source-`));
  // Beside the bundle, so the new app is moved into place instead of copied onto it: the move is a
  // rename, and a build that fails leaves the installed app exactly as it was.
  await mkdir(dirname(target.bundle), { recursive: true });
  const out = await mkdtemp(join(dirname(target.bundle), `.${ID}-app-build-`));
  try {
    await buildApp(source, root);
    const drawn = await icon(out);
    const [built] = await packager({
      dir: source,
      out,
      name,
      platform: "darwin",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      electronVersion: await electronVersion(),
      appBundleId: await identifierOf(target.bundle),
      appVersion: "1.0.0",
      icon: drawn ?? undefined,
      extendInfo: { NSMicrophoneUsageDescription: micUsage(name) },
      asar: true,
      overwrite: true,
    });
    if (!built) throw new Error("packager produced no app");
    // `packager` returns the output *directory* — `<name>-<platform>-<arch>`, holding the
    // bundle beside the licence files (its README: "Place `Foo Bar.app` in
    // `foobar/Foo Bar-darwin-arm64/`") — not the bundle itself. Copying that directory in as the
    // bundle nested one `.app` inside another, and macOS then refuses to open the outer one.
    const builtApp = join(built, `${name}.app`);
    if (!(await Bun.file(join(builtApp, "Contents", "Info.plist")).exists())) {
      throw new Error(`packager produced no app bundle in ${built}`);
    }

    // `open` on a running app only focuses it, so a rebuild would leave you looking at the old
    // one. Quit it first and start it afterwards — but only when this is a terminal run: the app
    // asking for its own reinstall is the app this would quit, and the step it runs in dies with
    // it (apps/server/src/app-update/update.ts).
    const wasRunning = target.relaunch && (await running(target.bundle));
    if (wasRunning) await quit(target.bundle);

    await rm(target.bundle, { recursive: true, force: true });
    // The packager wrote its frameworks with the relative symlinks they need, so nothing is copied
    // and nothing can arrive half-written.
    await rename(builtApp, target.bundle);
    // Finder caches bundles by path and date; touching it makes the new icon appear now.
    await sh(["touch", target.bundle]);

    console.log(`installed: ${target.bundle}`);
    console.log(`  serves:  ${root} on a fresh port at each launch (bun run dev keeps 4000)`);
    if (!drawn) console.log("  no icon: install librsvg for one (brew install librsvg)");
    if (target.relaunch) {
      await sh(["open", target.bundle]);
      console.log(
        wasRunning
          ? "  restarted: it was running, so it is running again — on the new build"
          : "  started: the new build is up (drag it to the Dock to keep it there)",
      );
    } else {
      console.log(
        "  unchanged: this app keeps running the build it started with — its restart loads this one",
      );
    }
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
}

async function uninstall(): Promise<void> {
  const bundle = installedBundle();
  if (!(await Bun.file(join(bundle, "Contents", "Info.plist")).exists())) {
    console.log(`not installed: ${bundle}`);
    return;
  }
  // Quit before removing: a running app whose bundle vanishes is a confusing thing to leave.
  if (await running(bundle)) await quit(bundle);
  await rm(bundle, { recursive: true, force: true });
  console.log(`removed: ${bundle}`);
}

export { install, uninstall };
