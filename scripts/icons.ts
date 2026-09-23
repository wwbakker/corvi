/** Renders assets/icon.svg to the PNG sizes the manifest and macOS need.
 *
 *   bun run icons
 *
 * The SVG is the source of truth; the PNGs are generated and checked in so a fresh clone can
 * serve them without librsvg installed. Requires `rsvg-convert` (brew install librsvg). */
import { mkdir } from "node:fs/promises";
import { sh } from "./sh.ts";

const out = "apps/web/src/app-root/icons";
await mkdir(out, { recursive: true });

const targets: { source: string; name: string; size: number }[] = [
  { source: "assets/icon.svg", name: "icon-192.png", size: 192 },
  { source: "assets/icon.svg", name: "icon-512.png", size: 512 },
  { source: "assets/icon.svg", name: "apple-touch-icon.png", size: 180 },
  { source: "assets/icon.svg", name: "favicon-32.png", size: 32 },
  { source: "assets/icon-maskable.svg", name: "icon-maskable-512.png", size: 512 },
];

for (const { source, name, size } of targets) {
  const r = await sh([
    "rsvg-convert",
    "-w",
    String(size),
    "-h",
    String(size),
    source,
    "-o",
    `${out}/${name}`,
  ]);
  if (r.code !== 0) throw new Error(`rsvg-convert failed for ${name}: ${r.stderr}`);
  console.log(`${out}/${name} (${size}px)`);
}
