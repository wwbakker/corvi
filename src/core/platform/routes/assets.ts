import { basename, join } from "node:path";
import { clientChunkPath, chunkRoot } from "../../host/clientChunks.ts";
import { guard } from "../origin.ts";
import { platformName } from "../platform.ts";
import { keysScript } from "../../../terminal/server/proxy.ts";
import index from "../../../frontend/index.html";

export const assetsRoutes = guard({
  "/terminal-keys.js": () =>
    new Response(keysScript(platformName), {
      headers: { "content-type": "text/javascript" },
    }),

  // The browser half of an out-of-tree extension, built at startup into the state dir and
  // imported by the page at runtime (src/core/host/client.tsx). Built-ins are in the page's
  // own bundle instead; an unknown name has no chunk and answers 404.
  "/extensions/:name/client.js": async (req) => {
    const file = Bun.file(clientChunkPath(req.params.name));
    return (await file.exists())
      ? new Response(file, { headers: { "content-type": "text/javascript" } })
      : new Response("no such extension client", { status: 404 });
  },

  // The react vendor chunks the page's import map points the out-of-tree clients at, built
  // from the app's own react entrypoints — so an out-of-tree step resolves react to the
  // same build the page runs (two reacts break hooks and context).
  "/vendor/:file": async (req) => {
    // basename: the parameter must not walk out of the vendor directory.
    const file = Bun.file(join(chunkRoot, "vendor", basename(req.params.file)));
    return (await file.exists())
      ? new Response(file, { headers: { "content-type": "text/javascript" } })
      : new Response("no such chunk", { status: 404 });
  },

  // The manifest is bundled with the page; its icons are plain files served from here.
  "/icons/:file": async (req) => {
    // basename: the parameter must not walk out of the icons directory.
    const file = Bun.file(join("src/frontend/icons", basename(req.params.file)));
    return (await file.exists()) ? new Response(file) : new Response("no such icon", { status: 404 });
  },

  "/*": index,
});
