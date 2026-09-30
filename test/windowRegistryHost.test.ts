import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import { listWindowsAsync, moveWindowAsync, newWindowAsync, selectWindowAsync, stopHostTerminals } from "../apps/server/src/terminals/server/windows.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * The registry's I/O half, against real host windows: new windows persist in order with one
 * active, select and move mutate the persisted records, a fresh read (a simulated restart) sees
 * the same, and a failed tmux read does not erase them.
 *
 * The tmux socket is this file's own, so the tmux reads here can never reach the user's server.
 */
const dir = await testTempDir("registry");
delete process.env.TMUX;
process.env.CORVI_HOST_RUNTIME = "node";
process.env.CORVI_TMUX_SOCKET = join(dir, "tmux.sock");
const changeId = "REG-IO";
const ids = (): string[] => registry.records(changeId).map((record) => record.id);

afterAll(async () => {
  await stopHostTerminals(changeId);
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
});

test("new windows persist in order with one active; select and move mutate them", async () => {
  const first = await newWindowAsync(changeId, dir);
  const second = await newWindowAsync(changeId, dir);
  let records = registry.records(changeId);
  expect(records.map((record) => record.id)).toEqual([first.id, second.id]);
  expect(records.filter((record) => record.active)).toHaveLength(1);
  expect(records.find((record) => record.active)?.id).toBe(second.id);

  await selectWindowAsync(changeId, 0);
  records = registry.records(changeId);
  expect(records[0]?.active).toBe(true);
  expect(records[1]?.active).toBe(false);

  await moveWindowAsync(changeId, 0, 1);
  expect(ids()).toEqual([second.id, first.id]);

  // A fresh read sees the same list: what a restart's rebuild starts from.
  expect(registry.read().changes[changeId]?.map((record) => record.id)).toEqual([second.id, first.id]);
}, 30_000);

test("a failed tmux read does not erase the registry", async () => {
  const before = ids();
  await listWindowsAsync(changeId); // tmux is not running at this socket: the read fails
  expect(ids()).toEqual(before);
}, 30_000);

test("completing a change stops its host sessions and forgets its windows", async () => {
  expect(ids().length).toBeGreaterThan(0);
  await stopHostTerminals(changeId);
  expect(registry.records(changeId)).toEqual([]);
  // The host sessions are killed, not merely forgotten.
  const { hostClient } = await import("../apps/server/src/terminals/server/host.ts");
  await waitFor(
    "the change's host sessions to be gone",
    async () => (await (await hostClient()).list()).every((session) => session.metadata?.change !== changeId || !session.alive),
    15_000,
  );
}, 30_000);
