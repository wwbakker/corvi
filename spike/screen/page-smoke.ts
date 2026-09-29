/**
 * A minimal real-page smoke: bundle a real `@xterm/xterm` + `@xterm/addon-serialize`, open it in
 * Chromium, restore a renderer-owned snapshot plus the tail, and compare the page's screen with a
 * headless terminal fed the same stream. This is the "real page" half of variant (a); the
 * serialization measurements use the shared core for speed.
 *
 *   node spike/screen/page-smoke.ts
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { feedBytes, makeTerminal, newSerializeAddon, restore, rowsText, snapshot } from "./xterm.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const esbuild = require("esbuild") as {
  buildSync: (options: Record<string, unknown>) => void;
};

esbuild.buildSync({
  entryPoints: [join(here, "page-entry.ts")],
  bundle: true,
  format: "iife",
  outfile: join(here, "page.js"),
  platform: "browser",
  logLevel: "silent",
});
writeFileSync(
  join(here, "page.html"),
  '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="page.js"></script></body></html>\n',
);

const COLS = 120;
const ROWS = 40;
const SCROLLBACK = 5000;
const stream = readFileSync(join(here, "stream.bin"));
const snapshotAt = Math.floor(stream.length * 0.6);

// The expected screen: the snapshot + tail, the way the runner does it.
const live = makeTerminal(COLS, ROWS, SCROLLBACK);
const liveAddon = newSerializeAddon();
live.loadAddon(liveAddon);
await feedBytes(live, stream.subarray(0, snapshotAt), 7);
const snap = snapshot(live, liveAddon);
const { term: expected, addon: expectedAddon } = restore(snap, COLS, ROWS, SCROLLBACK);
expected.write(snap);
await new Promise<void>((resolve) => expected.write("", () => resolve()));
await feedBytes(expected, stream.subarray(snapshotAt), 7);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(`file://${join(here, "page.html")}`);
const result = (await page.evaluate(
  (args: { snapshot: string; tail: string; cols: number; rows: number; scrollback: number }) =>
    window.restoreCheck(args.snapshot, args.tail, args.cols, args.rows, args.scrollback),
  { snapshot: snap, tail: Buffer.from(stream.subarray(snapshotAt)).toString("base64"), cols: COLS, rows: ROWS, scrollback: SCROLLBACK },
)) as { cursorX: number; cursorY: number; baseY: number; lines: string[]; serialized: string };
await browser.close();

const expectedBuffer = expected.buffer.active;
const expectedLines = rowsText(expected);
const checks = {
  "page.noErrors": errors.length === 0,
  "page.cursorMatches": result.cursorX === expectedBuffer.cursorX && result.cursorY === expectedBuffer.cursorY,
  "page.scrollMatches": result.baseY === expectedBuffer.baseY,
  "page.linesMatch":
    result.lines.length === expectedLines.length && result.lines.every((line, at) => line === expectedLines[at]),
  "page.serializedMatches": `${result.serialized}\x1b[${result.cursorY + 1};${result.cursorX + 1}H` === snapshot(expected, expectedAddon),
};

console.log(`READY ${JSON.stringify({ checks, lines: result.lines.length })}`);
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
