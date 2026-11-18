import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { HostStatusDto } from "@corvi/contracts/api";

import { ensureHost, type HostClient } from "../apps/server/src/terminals/host/client.ts";
import { HOST_DIR, hostBuildId } from "../apps/server/src/terminals/host/identity.ts";
import { startTestServer, stopTestServer, testTempDir, waitFor } from "./helpers.ts";

/**
 * The terminal host as the page sees it: the status read, and the restart the user's click sends.
 *
 * A host this server did not start is the ordinary case in a dev tree — every checkout shares one
 * state directory — so the route has to describe it without touching it, and only the restart may
 * end it. The host under test is a real one, started here rather than by the server.
 */
let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let other: string;
let host: HostClient;
let pid: number;

const hostSocket = (): string => join(tmp, "state", "corvi", "host.sock");

const status = async (): Promise<HostStatusDto> =>
  (await fetch(`${url}/api/terminals/host`).then((response) => response.json())) as HostStatusDto;

const alive = (candidate: number): boolean => {
  try {
    process.kill(candidate, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  tmp = await testTempDir("host-routes");
  ({ server, url } = await startTestServer(tmp));
  other = await testTempDir("host-routes-other");
}, 120_000);

afterAll(async () => {
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
}, 120_000);

/** Take the running host down, whatever identity it has: this stands in for the host's owner
 * going away — a shutdown, a crash — which is not a decision the server takes. */
const stopHost = async (): Promise<void> => {
  const { client } = await ensureHost({
    socket: hostSocket(),
    checkout: process.cwd(),
    buildId: "test",
    runtime: "node",
  });
  await client.shutdown().catch(() => undefined);
  client.close();
};

test("reports no host before one has been started", async () => {
  expect(await status()).toEqual({ running: false, identity: null, stale: [] });
});

test("describes a host from another checkout, and leaves it alone", async () => {
  // A host from another checkout with a shell in it: exactly what the server must keep rather than
  // take over, so it is the case worth describing.
  const started = await ensureHost({
    socket: hostSocket(),
    checkout: other,
    // The build id the server itself runs, so the only difference is the checkout.
    buildId: hostBuildId(HOST_DIR),
    runtime: "node",
  });
  host = started.client;
  pid = (await host.info()).pid;
  await host.open("keep", { cwd: other, command: ["/bin/sh", "-c", "sleep 30"], cols: 80, rows: 24 });

  const seen = await status();
  expect(seen.running).toBe(true);
  expect(seen.identity?.checkout).toBe(other);
  expect(seen.identity?.buildId).toBe(hostBuildId(HOST_DIR));
  expect(seen.stale).toEqual([{ kind: "checkout", theirs: other, ours: process.cwd() }]);
  expect(seen.sessions).toEqual({ live: 1, working: 0 });
  // The read is a read: the host it describes is still running with its shell.
  expect(alive(pid)).toBe(true);
});

test("an update never ends a shell: another build is reported, not replaced", async () => {
  // The update case: the host went on running the code it started with while the server now runs
  // other code. Nothing may end the shell inside it without a click, however empty or busy it is.
  await stopHost();
  const older = await ensureHost({
    socket: hostSocket(),
    checkout: process.cwd(),
    buildId: "oldercode",
    runtime: "node",
  });
  host = older.client;
  pid = (await host.info()).pid;
  await host.open("keep", { cwd: process.cwd(), command: ["/bin/sh", "-c", "sleep 30"], cols: 80, rows: 24 });

  const seen = await status();
  expect(seen.running).toBe(true);
  expect(seen.identity?.buildId).toBe("oldercode");
  expect(seen.stale).toEqual([{ kind: "build", theirs: "oldercode", ours: hostBuildId(HOST_DIR) }]);
  // Counted through the server's own client, so the server is talking to the host it kept.
  expect(seen.sessions).toEqual({ live: 1, working: 0 });
  expect(alive(pid)).toBe(true);
});

test("restart ends the old host and answers with the one that replaced it", async () => {
  const restarted = (await fetch(`${url}/api/terminals/host/restart`, {
    method: "POST",
  }).then((response) => response.json())) as HostStatusDto;

  expect(restarted.running).toBe(true);
  expect(restarted.stale).toEqual([]);
  // Ours now: the same checkout the server runs from, and the identity is the code identity this
  // server computes, not a version string.
  expect(restarted.identity?.checkout).toBe(process.cwd());
  expect(restarted.identity?.buildId).toBe(hostBuildId(HOST_DIR));
  expect(restarted.sessions).toBeUndefined();
  // Only the click ends a host: the shell the stale one held is gone with it.
  await waitFor("the old host to be retired", async () => !alive(pid));
  expect(await fetch(`${url}/api/terminals`).then((response) => response.json())).toEqual({});
  host.close();
});
