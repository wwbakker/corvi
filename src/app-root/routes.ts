import { basename, join } from "node:path";
import { guard } from "../capabilities/web.ts";
import index from "./index.html";

export const appRootRoutes = guard({
  // The manifest is bundled with the page; its icons are plain files served from here.
  "/icons/:file": async (req) => {
    // basename: the parameter must not walk out of the icons directory.
    const file = Bun.file(join("src/app-root/icons", basename(req.params.file)));
    return (await file.exists()) ? new Response(file) : new Response("no such icon", { status: 404 });
  },

  "/*": index,
});
