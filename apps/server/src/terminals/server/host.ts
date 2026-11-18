/**
 * The server's connection to the terminal host.
 *
 * One host per server state directory, adopted across restarts: `ensureHost` starts it if it is
 * not running and reuses the one that is, whether or not that host is the one this server would
 * have started. A host from another build or checkout is reported (`hostStatus`), not replaced:
 * replacing it would end every shell and agent inside it. The one replacement that is free — a
 * host of this checkout running other code with nothing alive in it — the client does itself.
 *
 * The host must run on Node (Bun never delivers pty output). The server is Node, so the runtime is
 * the server's own `process.execPath`; `CORVI_HOST_RUNTIME` overrides it for a test that runs under
 * Bun.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@corvi/configuration/node";
import {
  ensureHost,
  restartHost,
  type EnsureOptions,
  type HostClient,
  type SessionInfo,
} from "../host/client.ts";
import { HOST_DIR, hostBuildId } from "../host/identity.ts";

export type { HostClient, EnsureOptions, SessionInfo };

const socketPath = (): string => join(stateDir(), "host.sock");

/** The identity of the host code this server runs: a hash of the host's own modules. Cached, so a
 * `hostClient` call on every window tick does not re-read them. */
let buildId: string | undefined;
const buildIdOf = (): string => (buildId ??= hostBuildId(HOST_DIR));

/** What this server asks a host to be. One definition, so the client and the status read cannot
 * disagree about which host they are describing. */
export const hostOptions = (): EnsureOptions => ({
  socket: socketPath(),
  checkout: process.cwd(),
  buildId: buildIdOf(),
  ...(process.env.CORVI_HOST_RUNTIME !== undefined ? { runtime: process.env.CORVI_HOST_RUNTIME } : {}),
});

/** Whether a host already exists. A read-only caller uses this to avoid starting one: the
 * navigator's window list must not spawn a pty owner just to find nothing in it. */
export const hostRunning = (): boolean => existsSync(socketPath());

let connection: Promise<HostClient> | undefined;

/** The shared host client. The cache is discarded on a failed start and on a connection that has
 * since closed, so the next call re-runs `ensureHost` (which starts or adopts) instead of reusing
 * a poisoned promise forever. */
export const hostClient = async (): Promise<HostClient> => {
  const current = connection;
  if (current !== undefined) {
    const client = await current.catch(() => undefined);
    if (client !== undefined && !client.isClosed()) return client;
    if (connection === current) connection = undefined;
  }
  const started = ensureHost(hostOptions()).then((result) => result.client);
  connection = started;
  started.catch(() => {
    if (connection === started) connection = undefined;
  });
  return started;
};

/** Replace the host: retire the one that is running, whatever it is, and start ours. Only the
 * user's restart calls this, because it ends every pty the old host held. */
export const restartHostClient = async (): Promise<void> => {
  const current = connection;
  connection = undefined;
  const previous = await current?.catch(() => undefined);
  previous?.close();
  const restarted = await restartHost(hostOptions());
  connection = Promise.resolve(restarted.client);
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
