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

  // The page, and every one of its own routes: built ahead of time by `bun run build:web`,
  // served from the build directory.
  "/*": (req) => serveClient(new URL(req.url).pathname),
});
