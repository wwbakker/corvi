import type { ServerWebSocket } from "bun";
import { Effect } from "effect";
import { loadCache, saveCache } from "./cache.ts";
import { buildClientChunks } from "./core/host/clientChunks.ts";
import { assetsRoutes } from "./routes/assets.ts";
import { changesRoutes } from "./routes/changes.ts";
import { eventsRoutes } from "./routes/events.ts";
import { extensionsRoutes } from "./routes/extensions.ts";
import { reposRoutes } from "./routes/repos.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { terminalsRoutes } from "./routes/terminals.ts";
import { bridge, type Bridge } from "./terminalProxy.ts";

// What the CLIs said last time. Restarting is normal — a config change, a crash, an edit while
// `bun --hot` is not enough — and without this every page waits for the CLIs all over again.
const restored = await Effect.runPromise(loadCache);

// The browser halves of out-of-tree extensions, and the react vendor chunks they resolve
// against, built once at startup: after the extensions have loaded (their import awaited
// above), so the discovered client paths are known, and before the server listens, so the
// first page never races the chunks.
await buildClientChunks();

// Written now and then rather than on every entry: this is a cache, and losing the last minute
// of it costs one refresh.
setInterval(() => void Effect.runPromise(saveCache).catch(() => {}), 30_000).unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Effect.runPromise(saveCache)
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

const server = Bun.serve({
  // 4000 while developing; the app picks a fresh port at each launch, so the two never meet —
  // and nothing stale on a fixed port is ever mistaken for the app's server.
  port: Number(process.env.IWE_PORT ?? 4000),
  // Localhost only: the server acts as you, using your CLI credentials, so it has no auth of its own.
  hostname: "127.0.0.1",
  // The event stream is quiet by nature, and Bun closes an idle connection after ten seconds —
  // which the browser survives by reconnecting, noisily, six times a minute, for ever. The
  // stream sends a heartbeat as well; this is the belt to that pair of braces.
  idleTimeout: 120,
  development: process.env.NODE_ENV !== "production",
  // Typed here rather than on Bun.serve: naming the socket's data type there would take the
  // route handlers' own inference with it.
  websocket: {
    open: (ws) => bridge.open(ws as unknown as ServerWebSocket<Bridge>),
    message: (ws, message) => bridge.message(ws as unknown as ServerWebSocket<Bridge>, message),
    close: (ws) => bridge.close(ws as unknown as ServerWebSocket<Bridge>),
  },

  // One table per domain, each guarded as it is defined; composed here, where the server is.
  routes: {
    ...assetsRoutes,
    ...changesRoutes,
    ...eventsRoutes,
    ...extensionsRoutes,
    ...reposRoutes,
    ...settingsRoutes,
    ...terminalsRoutes,
  },
});

console.log(`iwe on ${server.url}${restored ? ` (${restored} cached answers restored)` : ""}`);

// The page is built on demand, and a failed build in production comes back as an empty 200 with
// no error anywhere — in the app's window that is a black screen, with nothing to say why. Ask
// for the page once at startup, where the answer is visible: a server whose page cannot build
// stops here (the window then reports it and points at this log) instead of blinding one.
{
  const page = await fetch(`${server.url}`).then((r) => r.text()).catch(() => "");
  if (!page.includes("<!doctype html>") || page.includes("Build Failed")) {
    console.error(
      `the page did not build — ${server.url} served ${page.length} bytes that are not the app`,
    );
    console.error(
      "usually dependencies: run `bun install`. For the full error: bun build src/web/index.html --outdir /tmp/iwe-check --production",
    );
    process.exit(1);
  }
}
