import { basename, join } from "node:path";
import { guard } from "../capabilities/web.ts";
import { fileResponse } from "../capabilities/files.ts";
import { serveClient } from "./client.ts";

export const appRootRoutes = guard({
  // The manifest is built with the page; its icons are plain files served from here.
  "/icons/:file": async (req) => {
    // basename: the parameter must not walk out of the icons directory.
    const response = await fileResponse(join("src/app-root/icons", basename(req.params.file)), {
      "content-type": "image/png",
    });
    return response ?? new Response("no such icon", { status: 404 });
  },

  // The page, and every one of its own routes: built once (production) or when its sources
  // change (development) by src/app-root/client.ts.
  "/*": (req) => serveClient(new URL(req.url).pathname),
});
