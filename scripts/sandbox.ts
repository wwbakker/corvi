/**
 * A copy of the app that cannot be confused with the one you use.
 *
 *   bun run app:sandbox              # builds /tmp/Corvi Sandbox.app
 *   bun run app:sandbox --open
 *
 * For trying something against a scratch server: a confirm sheet, a menu, whether an event
 * arrives without a reload. It differs from the installed app in the two ways that matter — its
 * own bundle identifier and its own name — so nothing addressed to one can reach the other.
 *
 * That is not hypothetical. A copy made with `cp -R` keeps the identifier `nl.wwbakker.corvi`,
 * and `tell application id "nl.wwbakker.corvi" to quit` then goes to whichever bundle the system
 * resolves: quitting the test copy quit the real app instead, in the middle of somebody's work.
 *
 * The copy's own bundle name is also what keys its Chromium profile
 * (apps/desktop/src/electron/main.ts), so the two do not share storage either.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sh } from "./sh.ts";
import { PRODUCT } from "@corvi/configuration/node";

const NAME = `${PRODUCT} Sandbox`;
const ID = "nl.wwbakker.corvi.sandbox";
const source = join(process.env.HOME ?? "", "Applications", `${PRODUCT}.app`);
const target = join("/tmp", `${NAME}.app`);

if (!(await Bun.file(join(source, "Contents", "Info.plist")).exists())) {
  console.error(`no app to copy: ${source} — run "bun run app:install" first`);
  process.exit(1);
}

// Quit any sandbox still running, by path: the one thing this script exists to keep separate.
await sh(["osascript", "-e", `tell application ${JSON.stringify(target)} to quit`]);
await rm(target, { recursive: true, force: true });

const must = (result: { readonly code: number; readonly stderr: string }, what: string): void => {
  if (result.code !== 0) {
    console.error(`${what}: ${result.stderr.trim() || "no output"}`);
    process.exit(1);
  }
};

must(await sh(["cp", "-R", source, target]), `could not copy ${source} to ${target}`);

const plist = join(target, "Contents", "Info.plist");
const set = (key: string, value: string): Promise<{ readonly code: number; readonly stderr: string }> =>
  sh(["/usr/libexec/PlistBuddy", "-c", `Set :${key} ${value}`, plist]);
must(await set("CFBundleIdentifier", ID), `could not set ${ID} in ${plist}`);
must(await set("CFBundleName", NAME), `could not set ${NAME} in ${plist}`);
must(await set("CFBundleDisplayName", NAME), `could not set ${NAME} in ${plist}`);

console.log(`${target}`);
console.log(`  serves its own fresh port at launch, as ${ID}`);
console.log(`  quit it with: osascript -e 'tell application "${target}" to quit'`);

if (process.argv.includes("--open")) await sh(["open", target]);
