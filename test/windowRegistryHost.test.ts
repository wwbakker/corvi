import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import { closePaneAsync, focusPaneAsync, listWindowsAsync, moveWindowAsync, newWindowAsync, selectWindowAsync, splitPaneAsync, stopHostTerminals } from "../apps/server/src/terminals/server/windows.ts";
import { TerminalSessions, terminalSessionsLayer } from "../apps/server/src/change/lifecycle-layer.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * The registry's I/O half, against real host windows: new windows persist in order with one
 * active, select and move mutate the persisted records, and a fresh read (a simulated restart)
 * sees the same. Since subagents moved to host sessions there is no second backing to merge.
 *
 * The state dir is this file's own (helpers.ts); no process outside it is touched.
 */
const dir = await testTempDir("registry");
// The env this file mutates, saved so a co-located test file does not inherit it (bun runs the
// files of a run in one process).
const savedEnv = {
  CORVI_HOST_RUNTIME: process.env.CORVI_HOST_RUNTIME,
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
const changeId = "REG-IO";
const ids = (): string[] => registry.records(changeId).map((record) => record.id);

afterAll(async () => {
  await stopHostTerminals(changeId);
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
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

test("a read rebuilds from the live host sessions and keeps the persisted order", async () => {
  const before = ids();
  await listWindowsAsync(changeId);
  expect(ids()).toEqual(before);
}, 30_000);

test("a window holds panes: split adds and focuses one, focus-pane moves, close-pane removes", async () => {
  const window = await newWindowAsync(changeId, dir);
  let record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toEqual([window.id]);
  expect(record.activePane).toBe(window.id);

  await splitPaneAsync(changeId, window.id, "right");
  record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toHaveLength(2);
  const pane = record.panes.find((entry) => entry !== window.id)!;
  // The window id is stable; the new pane is the focused one.
  expect(record.id).toBe(window.id);
  expect(record.activePane).toBe(pane);

  await focusPaneAsync(changeId, window.id, window.id);
  expect(registry.records(changeId).find((entry) => entry.id === window.id)?.activePane).toBe(window.id);

  // Closing the split pane leaves the window with its first pane.
  await closePaneAsync(changeId, window.id, pane);
  record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toEqual([window.id]);

  // Closing the last pane drops the window.
  await closePaneAsync(changeId, window.id, window.id);
  expect(registry.records(changeId).some((entry) => entry.id === window.id)).toBe(false);
}, 60_000);

test("the socket resolves the pane it names, not the active one", async () => {
  const window = await newWindowAsync(changeId, dir);
  await splitPaneAsync(changeId, window.id, "right");
  const record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  const firstPane = record.panes[0]!;
  const secondPane = record.panes[1]!;
  expect(record.activePane).toBe(secondPane); // the split is focused

  const { openSession, closeAttachments, flushScreens } = await import("../apps/server/src/terminals/server/session.ts");
  // The page names the first pane; the session it gets is that pane's, not the active one.
  const session = await openSession(changeId, dir, { cols: 80, rows: 24 }, firstPane);
  expect(session.sessionId).toBe(firstPane);
  flushScreens();
  closeAttachments();
}, 60_000);

test("completing/cancelling a change stops its host sessions through the lifecycle service", async () => {
  expect(ids().length).toBeGreaterThan(0);
  // The product's own stop (the `TerminalSessions` capability `completeChange`/`cancelChange`
  // call), not the raw windows helper: this is the path a completed change takes.
  await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(TerminalSessions, (sessions) => sessions.stop(changeId as Parameters<typeof sessions.stop>[0])),
      terminalSessionsLayer,
    ),
  );
  expect(registry.records(changeId)).toEqual([]);
  // The host sessions are killed, not merely forgotten.
  const { hostClient } = await import("../apps/server/src/terminals/server/host.ts");
  await waitFor(
    "the change's host sessions to be gone",
    async () => (await (await hostClient()).list()).every((session) => session.metadata?.change !== changeId || !session.alive),
    15_000,
  );
}, 30_000);
