/**
 * A copy of the app that cannot be confused with the one you use.
 *
 *   bun run app:sandbox 4090          # builds /tmp/IWE Sandbox.app against port 4090
 *   bun run app:sandbox 4090 --open
 *
 * For trying something against a scratch server: a confirm sheet, a menu, whether an event
 * arrives without a reload. It differs from the installed app in the three ways that matter —
 * its own bundle identifier, its own name, its own port — so nothing addressed to one can reach
 * the other.
 *
 * That is not hypothetical. A copy made with `cp -R` keeps the identifier `dev.iwe.app`, and
 * `tell application id "dev.iwe.app" to quit` then goes to whichever bundle the system resolves:
 * quitting the test copy quit the real app instead, in the middle of somebody's work.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sh } from "../src/sh.ts";

const NAME = "IWE Sandbox";
const ID = "dev.iwe.app.sandbox";
const source = join(process.env.HOME ?? "", "Applications", "Integrated Work Environment.app");
const target = join("/tmp", `${NAME}.app`);

const port = process.argv[2];
if (!port || !/^\d+$/.test(port)) {
  console.error("usage: bun run app:sandbox <port> [--open]");
  process.exit(1);
}

if (!(await Bun.file(join(source, "Contents", "Info.plist")).exists())) {
  console.error(`no app to copy: ${source} — run "bun run app:install" first`);
  process.exit(1);
}

// Quit any sandbox still running, by path: the one thing this script exists to keep separate.
await sh(["osascript", "-e", `tell application ${JSON.stringify(target)} to quit`]);
await rm(target, { recursive: true, force: true });
await sh(["cp", "-R", source, target]);

const plist = join(target, "Contents", "Info.plist");
const set = (key: string, value: string): Promise<unknown> =>
  sh(["/usr/libexec/PlistBuddy", "-c", `Set :${key} ${value}`, plist]);
await set("CFBundleIdentifier", ID);
await set("CFBundleName", NAME);
await set("CFBundleDisplayName", NAME);
await set("IWEPort", port);

console.log(`${target}`);
console.log(`  serves port ${port}, as ${ID}`);
console.log(`  quit it with: osascript -e 'tell application "${target}" to quit'`);

if (process.argv.includes("--open")) await sh(["open", target]);
