import { Effect } from "effect";
import { loadCache, saveCache } from "./capabilities/cache.ts";
import { eventsRoutes } from "./capabilities/bus.ts";
import { serve, type ServerWebSocket } from "./capabilities/serve.ts";
import { buildClientChunks } from "./extension-host/clientChunks.ts";
import { extensionHostRoutes } from "./extension-host/routes.ts";
import { appRootRoutes } from "./app-root/routes.ts";
import { changeRoutes } from "./change/routes.ts";
import { repositoriesRoutes } from "./change/repositories-route.ts";
import { dashboardRoutes } from "./dashboard/routes.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { terminalsRoutes } from "./terminals/routes.ts";
import { workspaceRoutes } from "./workspace/routes.ts";
import { terminalSockets, type TerminalSocket } from "./terminals/server/session.ts";
import { ID, env } from "./capabilities/identity.ts";

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

const server = await serve<TerminalSocket>({
  // 4000 while developing; the app picks a fresh port at each launch, so the two never meet —
  // and nothing stale on a fixed port is ever mistaken for the app's server.
  port: Number(process.env[env("PORT")] ?? 4000),
  // Localhost only: the server acts as you, using your CLI credentials, so it has no auth of its own.
  hostname: "127.0.0.1",
  // One table per domain, each guarded as it is defined; composed here, where the server is.
  routes: {
    ...appRootRoutes,
    ...changeRoutes,
    ...repositoriesRoutes,
    ...dashboardRoutes,
    ...eventsRoutes,
    ...extensionHostRoutes,
    ...settingsRoutes,
    ...terminalsRoutes,
    ...workspaceRoutes,
  },
  websocket: {
    open: (ws: ServerWebSocket<TerminalSocket>) => terminalSockets.open(ws),
    message: (ws: ServerWebSocket<TerminalSocket>, message: string | Uint8Array) =>
      terminalSockets.message(ws, message),
    close: (ws: ServerWebSocket<TerminalSocket>) => terminalSockets.close(ws),
  },
});

console.log(`${ID} on ${server.url}${restored ? ` (${restored} cached answers restored)` : ""}`);

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
      "usually dependencies: run `bun install` in the checkout. The esbuild error is above — the app writes it to its own log.",
    );
    process.exit(1);
  }
}
