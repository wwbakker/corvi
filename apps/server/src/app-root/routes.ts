import { basename, join } from "node:path";

import { fileResponse } from "../capabilities/files.ts";
import { guard } from "../capabilities/web.ts";
import { pageDir, serveClient } from "./pages.ts";

export const appRootRoutes = guard({
  // The manifest is built with the page; its icons are plain files served from the build.
  "/icons/:file": async (req) => {
    // basename: the parameter must not walk out of the icons directory.
    const response = await fileResponse(join(pageDir(), "icons", basename(req.params.file)), {
      "content-type": "image/png",
    });
    return response ?? new Response("no such icon", { status: 404 });
  },

  // The icon font the stylesheet falls back to, copied into the build when `bun install` fetched
  // it; a build without it answers 404 and the page renders with the rest of its font stack.
  "/fonts/:file": async (req) => {
    const file = basename(req.params.file);
    const response = await fileResponse(join(pageDir(), "fonts", file), {
      "content-type": file.endsWith(".ttf") ? "font/ttf" : "text/plain; charset=utf-8",
      // 2.6 MB a page would otherwise fetch on every load, which tells over remote access. A day,
      // not immutable: the name carries no version, and a Nerd Fonts bump keeps it.
      "cache-control": "public, max-age=86400",
    });
    return response ?? new Response("no such font", { status: 404 });
  },

  // The page, and every one of its own routes: built ahead of time by `bun run build:web`,
  // served from the build directory.
  "/*": (req) => serveClient(new URL(req.url).pathname),
});
