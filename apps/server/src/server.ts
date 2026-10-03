import { Effect } from "effect";
import { resolve } from "node:path";
import { createCache } from "./capabilities/cache.ts";
import { setRuntime } from "./capabilities/runtime.ts";
import { eventsRoutes } from "./capabilities/bus.ts";
import { serve, type ServerWebSocket } from "./capabilities/serve.ts";
import { integrationRoutes } from "./integrations/routes.ts";
import { appRootRoutes } from "./app-root/routes.ts";
import { identityRoutes } from "./app-root/identity.ts";
import { pruneInstanceRecords, removeInstanceRecord, writeInstanceRecord } from "./app-root/instance.ts";
import { actionsRoutes } from "./actions/routes.ts";
import { changeRoutes } from "./change/routes.ts";
import { repositoriesRoutes } from "./change/repositories-route.ts";
import { dashboardRoutes } from "./dashboard/routes.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { subagentsRoutes } from "./subagents/routes.ts";
import { terminalsRoutes } from "./terminals/routes.ts";
import { workspaceRoutes } from "./workspace/routes.ts";
import { appUpdateRoutes } from "./app-update/routes.ts";
import {
  closeInterruptedUpdate,
  startUpdateChecks,
  type AppUpdateOptions,
} from "./app-update/update.ts";
import { terminalSockets, closeAttachments, flushScreens, type TerminalSocket } from "./terminals/server/session.ts";
import { loadSnapshots } from "./terminals/server/snapshots.ts";
import { migrateStoredRecords } from "@corvi/changes/node";
import { changePairs } from "./change/server/store.ts";
import { putCliOnPath } from "./capabilities/env.ts";
import { commandAvailable } from "./capabilities/os.ts";
import { ID, env } from "@corvi/configuration/node";

// The CLI on PATH for every session this server starts (see the function's own comment). The checkout is
// where this server's own code lives — derived from this file, not the cwd: every documented
// launch sets the cwd too, but only this cannot be wrong. Before the first client is spawned
// anywhere below.
putCliOnPath(resolve(import.meta.dirname, "../../.."), commandAvailable("corvi"));

// The runtime this process owns: the cache is constructed here and restored before the server
// listens, and requests read it through `capabilitiesLayer`. What the CLIs said last time is
// worth keeping — restarting is normal, and without this every page waits for the CLIs again.
const cache = createCache();
const restored = await Effect.runPromise(cache.load());
setRuntime({ cache });

// The server-owned screens persisted by the last run, loaded before the watcher or any page can
// prune them: this is what keeps deep scrollback across a Corvi restart.
loadSnapshots();

// One sweep of the record formats at startup: a change.json still in format 1 is projected to
// the current one before the first request. Reported and never fatal — every read migrates
// lazily anyway — and the sweep is what makes one shape on disk the normal state.
void Effect.runPromise(
  migrateStoredRecords({ roots: changePairs() }),
).catch((error) => console.error("could not migrate change records:", error));

// The app update: only the installed app updates itself (its window marks this run), and only
// from its own checkout. The interrupted-run sweep closes a journal the last server left open,
// before any page can read it as a run that is still going.
const appUpdate: AppUpdateOptions = {
  root: resolve("."),
  app: process.env[env("APP_KIND")] === "app",
};
await Effect.runPromise(closeInterruptedUpdate()).catch((error) =>
  console.error("could not close the update journal:", error),
);
startUpdateChecks(appUpdate);

// Written now and then rather than on every entry: this is a cache, and losing the last minute
// of it costs one refresh.
setInterval(() => void Effect.runPromise(cache.save()).catch(() => {}), 30_000).unref();
// The port this server is listening on, once it is: the signal handler removes the discovery
// record by it (see `./app-root/instance.ts`).
let instancePort: number | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Flush the screens to the store before the server takes its pty attachments with it; the host
    // sessions (and the shells in them) stay for the next server.
    flushScreens();
    closeAttachments();
    if (instancePort !== undefined) removeInstanceRecord(instancePort);
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
    ...identityRoutes,
    ...appUpdateRoutes(appUpdate),
    ...actionsRoutes,
    ...changeRoutes,
    ...repositoriesRoutes,
    ...dashboardRoutes,
    ...eventsRoutes,
    ...integrationRoutes,
    ...settingsRoutes,
    ...subagentsRoutes,
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

instancePort = server.port;
// Sweep records a hard kill or a reboot left behind, then write this one: a client that reads the
// readiness line and immediately looks for the record sees only live servers to probe.
await pruneInstanceRecords();
// Before the readiness line, so a client that reads the line and immediately looks for the
// record cannot lose the race.
await writeInstanceRecord(server.url.toString(), server.port);
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
    removeInstanceRecord(server.port);
    process.exit(1);
  }
}
