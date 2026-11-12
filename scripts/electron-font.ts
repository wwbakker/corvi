/**
 * Whether this Electron's Chromium still accepts the canvas font xterm's WebGL renderer builds.
 *
 *   bun run electron:check                     # the binary this checkout runs
 *   bun run electron:check <path-to-Electron>  # a candidate, unpacked anywhere
 *
 * The WebGL renderer builds its glyph-atlas font as `"${italic ? "italic" : ""} ${weight}
 * ${size}px ${family}"`, so every upright glyph is drawn with a font string that starts with a
 * space (xtermjs/xterm.js#6297). Electron 45.2.3 backported a Chromium font-parser change without
 * its follow-up fix, and `ctx.font` then rejects that string and keeps its `10px sans-serif`
 * default — the atlas draws glyphs too small for their cells, and every terminal in the window
 * reads as tiny and airily spaced (electron/electron#55616). The DOM renderer, and with it every
 * headless test, builds its font without the leading space and is unaffected.
 *
 * `apps/desktop/package.json` pins `electron` below the regression for that reason
 * (docs/decisions/electron-version.md). This is the check that says when the pin can move: it
 * exits non-zero while the font is rejected, and names both reports.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { electronBinary } from "@corvi/desktop/binary";

/** The string xterm's texture atlas sets, with the italic slot empty as it is for upright text. */
const ATLAS_FONT = " normal 24px monospace";

/** The same font in the canonical shorthand, which every version parses: what acceptance
 * looks like. */
const CANONICAL_FONT = ATLAS_FONT.trim();

/** A window with a document and nothing else: the probe needs a renderer, not the app. */
const MAIN = `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 320, height: 200 });
  await win.loadURL("data:text/html,<body></body>");
});
`;

type Probe = {
  readonly canvas: string;
  readonly offscreen: string;
  readonly canvasFontsCheck: string;
  readonly reference: string;
};

const requested = process.argv[2];
const binary = requested === undefined ? electronBinary() : resolve(requested);
if (binary === undefined) {
  console.error("electron is not installed — run `bun install`");
  process.exit(1);
}
if (!existsSync(binary)) {
  console.error(`no Electron binary at ${binary} — run \`bun run electron:install\``);
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "corvi-electron-font-"));
await writeFile(join(dir, "package.json"), `{ "name": "corvi-electron-font", "main": "main.cjs" }`);
await writeFile(join(dir, "main.cjs"), MAIN);

const application = await _electron.launch({ executablePath: binary, args: [dir] });
let accepted = false;
try {
  const page = await application.firstWindow();
  const userAgent: string = await page.evaluate(() => navigator.userAgent);
  const electron = /Electron\/([\d.]+)/.exec(userAgent)?.[1] ?? "unknown";
  const chromium = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? "unknown";
  const probe: Probe = await page.evaluate(
    (fonts: { readonly atlas: string; readonly canonical: string }): Probe => {
      const canvas = document.createElement("canvas").getContext("2d");
      if (canvas === null) throw new Error("no 2d canvas context");
      canvas.font = fonts.atlas;
      const offscreen = new OffscreenCanvas(1, 1).getContext("2d");
      if (offscreen !== null) offscreen.font = fonts.atlas;
      let canvasFontsCheck = "ok";
      try {
        document.fonts.check(fonts.atlas);
      } catch (error) {
        canvasFontsCheck = (error as Error).name;
      }
      const reference = document.createElement("canvas").getContext("2d");
      if (reference === null) throw new Error("no 2d canvas context");
      reference.font = fonts.canonical;
      return {
        canvas: canvas.font,
        offscreen: offscreen === null ? "none" : offscreen.font,
        canvasFontsCheck,
        reference: reference.font,
      };
    },
    { atlas: ATLAS_FONT, canonical: CANONICAL_FONT },
  );

  // Acceptance is what came back, not what was asked for: a rejected assignment leaves the
  // context's previous font in place, which is the whole failure.
  accepted = probe.canvas === probe.reference;
  console.log(`electron ${electron} · Chromium ${chromium} · ${binary}`);
  console.log(`  canvas font ${JSON.stringify(ATLAS_FONT)} → ${probe.canvas}`);
  console.log(`  offscreen canvas → ${probe.offscreen} · document.fonts.check → ${probe.canvasFontsCheck}`);
  console.log(
    accepted
      ? "  accepted: the WebGL renderer draws glyphs at their size"
      : "  rejected: the canvas kept its default font, so the atlas draws glyphs far too small",
  );
} finally {
  await application.close();
  await rm(dir, { recursive: true, force: true });
}

if (!accepted) {
  console.error(
    "the terminal would render at 10px sans-serif — do not raise the electron pin to this version " +
      "(xtermjs/xterm.js#6297, electron/electron#55616)",
  );
  process.exit(1);
}
