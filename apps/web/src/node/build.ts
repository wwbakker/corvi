/**
 * The page's bundle, built ahead of time with esbuild.
 *
 * The browser application lives in `apps/web/src`; this is the one place that knows how it is
 * put together: the entry and styles are bundled, the HTML's two local references are rewritten,
 * and the icons and manifest are copied beside them. The server only serves the result
 * (`apps/server/src/app-root/pages.ts`), so a production instance never runs a bundler and a
 * missing bundle is a build problem, not a page problem.
 *
 * `bun run build:web` runs this once; `--watch` rebuilds when a source file changes.
 */
import { build } from "esbuild";
import { watch } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the browser sources live: `apps/web/src/app-root`. */
const sourceDir = fileURLToPath(new URL("../app-root", import.meta.url));

/** Where a build goes when no output directory is named: `apps/web/dist`. */
export const defaultOutDir = fileURLToPath(new URL("../../dist", import.meta.url));

/** One bundle, written through a temp file: a reader never sees a half-written file. */
async function bundle(entrypoint: string, outfile: string): Promise<void> {
  const result = await build({
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    write: false,
  });
  for (const file of result.outputFiles) {
    const temporary = `${file.path}.tmp-${process.pid}`;
    await writeFile(temporary, file.contents);
    await rename(temporary, file.path);
  }
}

/**
 * Build the page into `outDir` (default `apps/web/dist`). The HTML keeps its shape; only two
 * references change: the script is the bundle above, and the icons are the copied files the
 * server's `/icons` route serves.
 */
export async function buildWeb(options: { outDir?: string } = {}): Promise<string> {
  const outDir = resolve(options.outDir ?? defaultOutDir);
  await mkdir(outDir, { recursive: true });
  await bundle(join(sourceDir, "app.tsx"), join(outDir, "app.js"));
  await bundle(join(sourceDir, "styles.css"), join(outDir, "styles.css"));
  const html = (await readFile(join(sourceDir, "index.html"), "utf8"))
    .replace("./app.tsx", "./app.js")
    .replaceAll("./icons/", "/icons/");
  await writeFile(join(outDir, "index.html"), html);
  await cp(join(sourceDir, "manifest.webmanifest"), join(outDir, "manifest.webmanifest"));
  await cp(join(sourceDir, "icons"), join(outDir, "icons"), { recursive: true });
  return outDir;
}

/** Build once, then rebuild whenever a source file changes. */
async function watchWeb(outDir: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(sourceDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void buildWeb({ outDir }).then(
        () => console.log(`web: rebuilt ${outDir}`),
        (e: unknown) =>
          console.error(`web: rebuild failed — ${e instanceof Error ? e.message : String(e)}`),
      );
    }, 100);
  });
  console.log(`web: watching ${sourceDir}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outDir = resolve(outIndex >= 0 ? (args[outIndex + 1] ?? defaultOutDir) : defaultOutDir);
  await buildWeb({ outDir });
  console.log(`web: built ${outDir}`);
  if (args.includes("--watch")) await watchWeb(outDir);
}
