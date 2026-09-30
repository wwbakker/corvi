/**
 * The server's connection to the terminal host.
 *
 * One host per server state directory, adopted across restarts: `ensureHost` starts it if it is
 * not running and reuses the one that is. Everything the terminal module needs from the host goes
 * through this client; nothing else in the server speaks the host protocol.
 *
 * The host must run on Node (Bun never delivers pty output). The server is Node, so the runtime is
 * the server's own `process.execPath`; `CORVI_HOST_RUNTIME` overrides it for a test that runs under
 * Bun.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@corvi/configuration/node";
import { ensureHost, type HostClient, type SessionInfo } from "../host/client.ts";

export type { HostClient, SessionInfo };

const socketPath = (): string => join(stateDir(), "host.sock");

/** Whether a host already exists. A read-only caller uses this to avoid starting one: the
 * navigator's window list must not spawn a pty owner just to find nothing in it. */
export const hostRunning = (): boolean => existsSync(socketPath());

let connection: Promise<HostClient> | undefined;

/** The shared host client, started on first use and kept for the server's life. */
export const hostClient = (): Promise<HostClient> => {
  connection ??= ensureHost({
    socket: socketPath(),
    checkout: process.cwd(),
    buildId: process.env.CORVI_BUILD ?? "dev",
    ...(process.env.CORVI_HOST_RUNTIME !== undefined ? { runtime: process.env.CORVI_HOST_RUNTIME } : {}),
  }).then((result) => result.client);
  return connection;
};

/** Shut the host down and forget it. Used by a test that must leave no process behind; the
 * server itself lets the host outlive it, which is the point of the host. */
export const closeHostClient = async (): Promise<void> => {
  const current = connection;
  connection = undefined;
  if (current === undefined) return;
  const client = await current.catch(() => undefined);
  await client?.shutdown().catch(() => undefined);
  client?.close();
};
