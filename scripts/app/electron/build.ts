/**
 * Builds the Electron host — `main.ts` and `preload.ts` — into a directory Electron can run.
 *
 * Electron executes JavaScript, not TypeScript, and it ships its own Node, so the two files are
 * bundled with Bun's bundler into CommonJS (the format a sandboxed preload must be). The bundle
 * writes a `package.json` beside them saying where the checkout to serve is (`corviRoot`), which
 * is read at launch — the `IWERoot` of the Swift app's Info.plist, in the one place both
 * platforms already look.
 *
 * `electron` is external: the built-in module resolves inside Electron, and bundling the npm
 * package that merely *finds* the binary would break both the size and the meaning.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ID } from "../../../apps/server/src/capabilities/identity.ts";

export async function buildApp(outDir: string, root: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const entries: [entry: string, out: string][] = [
    ["main.ts", "main.cjs"],
    ["preload.ts", "preload.cjs"],
  ];
  for (const [entry, out] of entries) {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, entry)],
      outdir: outDir,
      naming: out,
      target: "node",
      format: "cjs",
      external: ["electron"],
    });
    if (!result.success) {
      throw new Error(
        `${entry} did not build:\n${result.logs.map((log) => log.message).join("\n")}`,
      );
    }
  }
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify({ name: ID, version: "1.0.0", main: "main.cjs", corviRoot: root }, null, 2)}\n`,
  );
}
