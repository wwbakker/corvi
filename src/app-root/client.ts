/**
 * The page's bundle, built with esbuild.
 *
 * esbuild bundles the page's script and stylesheet. The HTML is copied with local references
 * rewritten. The route
 * (src/app-root/routes.ts) serves the result, falling back to index.html for the SPA's own
 * paths.
 *
 * Built lazily into the state directory — the server's own startup check is what builds it in
 * production — so tests that never open a page never pay for it. In development a rebuilt page
 * is picked up on the next request; in production it is built once.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileResponse, writeAtomic } from "../capabilities/files.ts";
import { stateDir } from "../capabilities/identity.ts";

/** Where the built page lives. */
export const clientDir = join(stateDir(), "client");

const sourceDir = "src/app-root";

const contentType: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

let built = false;
let builtAt = 0;
/** The build in flight, shared: two requests arriving together (the server's own startup check
 * and the page's first request) must not build the page twice into the same files. */
let building: Promise<void> | null = null;

/** One bundle, written into place atomically — esbuild writes through this rather than to a
 * path directly, so a reader never sees a half-written file. */
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
  for (const file of result.outputFiles) await writeAtomic(file.path, file.contents);
}

async function buildClient(): Promise<void> {
  await mkdir(clientDir, { recursive: true });
  await bundle(join(sourceDir, "app.tsx"), join(clientDir, "app.js"));
  await bundle(join(sourceDir, "styles.css"), join(clientDir, "styles.css"));
  // The HTML keeps its shape; only two references change: the script is the bundle above, and
  // the icons are the committed files the /icons route already serves — the old Bun HTML import
  // inlined them, fingerprinted, into the built page.
  const html = (await readFile(join(sourceDir, "index.html"), "utf8"))
    .replace("./app.tsx", "./app.js")
    .replaceAll("./icons/", "/icons/");
  await writeAtomic(join(clientDir, "index.html"), html);
  await cp(join(sourceDir, "manifest.webmanifest"), join(clientDir, "manifest.webmanifest"));
}

/** The newest mtime under a directory, depth first. */
async function newest(dir: string): Promise<number> {
  let found = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found = Math.max(found, await newest(path));
    else found = Math.max(found, (await stat(path)).mtimeMs);
  }
  return found;
}

/**
 * The page, built and current. Production builds once; development rebuilds when a source file
 * is newer than the last build, which is what makes editing the page a refresh rather than a
 * server restart.
 */
export async function ensureClient(): Promise<void> {
  const development = process.env.NODE_ENV !== "production";
  if (built && !development) return;
  const newestSource = development ? await newest("src") : 0;
  if (built && newestSource <= builtAt) return;
  building ??= buildClient()
    .then(() => {
      built = true;
      builtAt = newestSource;
    })
    .finally(() => {
      building = null;
    });
  await building;
}

/** A path on this origin: a built asset if it is one, index.html otherwise — the app is an SPA,
 * and its own routes (/changes/…, /settings) are not files. */
export async function serveClient(pathname: string): Promise<Response> {
  await ensureClient();
  const name = pathname === "/" ? "index.html" : basename(pathname);
  if (name !== "index.html") {
    const response = await fileResponse(join(clientDir, name), {
      "content-type": contentType[extname(name)] ?? "application/octet-stream",
    });
    if (response) return response;
  }
  return new Response(await readFile(join(clientDir, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
