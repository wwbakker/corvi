/**
 * Opens the app's own window with Playwright and reports what it did.
 *
 *   bun run app:drive                 # build, open, report, close
 *   bun run app:drive --shot          # also write shots/app.png
 *   bun run app:drive --keep          # leave the window open until it is closed
 *
 * Playwright drives the page better than any AppleScript, and with Electron it can drive the
 * app's window too: this replaces the JXA script that walked the Swift app's accessibility tree
 * to click its sheets. It needs no Accessibility permission — Playwright
 * talks CDP, not the UI tree — and it works on Linux as well as macOS.
 *
 * Environment passes through (`CORVI_ROOT`, `CORVI_CONFIG`, `CORVI_PORT`), so pointing it at a scratch
 * server is one export away; the app builds to the same place `bun run app:run` uses.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron } from "playwright";
import { buildApp } from "./app/electron/build.ts";
import { electronBinary } from "./app/electron/binary.ts";
import { devAppDir } from "./app/run.ts";
import { ID, env } from "../apps/server/src/capabilities/identity.ts";

const root = resolve(".");
const dir = devAppDir();
await buildApp(dir, root);

const electron = electronBinary(root);
if (!existsSync(electron)) {
  console.error("no Electron binary — run `bun install` (app:install downloads it)");
  process.exit(1);
}

const app = await _electron.launch({
  executablePath: electron,
  args: [dir],
  env: Object.assign({}, process.env, { [env("APP_ROOT")]: root }),
});

const errors: string[] = [];
const dialogs: string[] = [];
const page = await app.firstWindow();
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => {
  // A dialog the page did not expect blocks it; dismiss it so the run can finish, and say so.
  dialogs.push(`${dialog.type()}: ${dialog.message()}`);
  void dialog.dismiss();
});

// The window shows "Starting Corvi…" until the server answers, then loads the page; the sidebar is
// the first thing that exists only there.
await page.waitForSelector(".sidebar", { timeout: 30_000 });
console.log(`window: ${await page.title()}`);
console.log(`  url:  ${page.url()}`);
console.log(
  `  host: ${await page.evaluate(() => typeof (window as { corviHost?: unknown }).corviHost)}`,
);

if (process.argv.includes("--notify")) {
  // Exercise the host path (the app's own notification, not the browser fallback) and give it a
  // moment to be shown by the desktop's notification daemon.
  await page.evaluate(() =>
    (window as unknown as { corviHost: { notify: (payload: unknown) => void } }).corviHost.notify({
      kind: "notify",
      id: `${ID}-drive`,
      title: `${ID} drive`,
      subtitle: "notification check",
      body: "the host path works",
      sound: false,
      change: "drive",
      window: "@1",
    }),
  );
  await page.waitForTimeout(1500);
}

if (process.argv.includes("--shot")) {
  await mkdir("shots", { recursive: true });
  await page.screenshot({ path: "shots/app.png" });
  console.log("  shot: shots/app.png");
}
if (dialogs.length) console.log(`dialogs:\n  ${dialogs.join("\n  ")}`);
if (errors.length) console.log(`console errors:\n  ${errors.join("\n  ")}`);

if (process.argv.includes("--keep")) {
  // Leave it open until the window closes (or the run is interrupted).
  await new Promise<void>((resolve) => app.on("close", () => resolve()));
} else {
  await app.close();
}
