import { Effect } from "effect";
import { createCache } from "./capabilities/cache.ts";
import { setRuntime } from "./capabilities/runtime.ts";
import { eventsRoutes } from "./capabilities/bus.ts";
import { serve, type ServerWebSocket } from "./capabilities/serve.ts";
import { integrationRoutes } from "./integrations/routes.ts";
import { appRootRoutes } from "./app-root/routes.ts";
import { changeRoutes } from "./change/routes.ts";
import { repositoriesRoutes } from "./change/repositories-route.ts";
import { dashboardRoutes } from "./dashboard/routes.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { terminalsRoutes } from "./terminals/routes.ts";
import { workspaceRoutes } from "./workspace/routes.ts";
import { terminalSockets, closeAttachments, type TerminalSocket } from "./terminals/server/session.ts";
import { ID, env } from "@corvi/configuration/node";

// The runtime this process owns: the cache is constructed here and restored before the server
// listens, and requests read it through `capabilitiesLayer`. What the CLIs said last time is
// worth keeping — restarting is normal, and without this every page waits for the CLIs again.
const cache = createCache();
const restored = await Effect.runPromise(cache.load());
setRuntime({ cache });

// Written now and then rather than on every entry: this is a cache, and losing the last minute
// of it costs one refresh.
setInterval(() => void Effect.runPromise(cache.save()).catch(() => {}), 30_000).unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The server takes its pty attachments with it; the tmux sessions (and the shells in them)
    // stay for the next server.
    closeAttachments();
    void Effect.runPromise(cache.save())
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
    ...integrationRoutes,
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
      `the page was not built — ${server.url} served ${page.length} bytes that are not the app`,
    );
    console.error(
      "build it with `bun run build:web` (or `bun run app:install`, which does), then start the server again.",
    );
    process.exit(1);
  }
}
