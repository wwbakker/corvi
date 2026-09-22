/**
 * The page, served from the build that was made ahead of time.
 *
 * `bun run build:web` writes the browser bundle into `apps/web/dist` (or wherever
 * `CORVI_WEB_DIST` points, which is how an installed app names its own copy). This module is
 * the server's whole relationship with it: find the files, serve them, and fall back to
 * `index.html` for the SPA's own paths. There is no bundler here — a missing build is a build
 * problem, and `server.ts` says so at startup rather than serving a blank 200.
 */
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileResponse } from "../capabilities/files.ts";
import { env } from "../capabilities/identity.ts";

const contentType: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Where the built page is. Relative by default so a checkout runs where it is; an installed
 * app sets `CORVI_WEB_DIST`. */
export const pageDir = (): string => resolve(process.env[env("WEB_DIST")] ?? "apps/web/dist");

/** A path on this origin: a built asset if it is one, index.html otherwise — the app is an SPA,
 * and its own routes (/changes/…, /settings) are not files. */
export async function serveClient(pathname: string): Promise<Response> {
  const name = pathname === "/" ? "index.html" : basename(pathname);
  if (name !== "index.html") {
    const response = await fileResponse(join(pageDir(), name), {
      "content-type": contentType[extname(name)] ?? "application/octet-stream",
    });
    if (response) return response;
  }
  return new Response(await readFile(join(pageDir(), "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
