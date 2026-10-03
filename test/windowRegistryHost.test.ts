import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { closeHostClient, hostClient } from "../apps/server/src/terminals/server/host.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import { closePaneAsync, focusPaneAsync, isKeptOpen, listWindowsAsync, moveWindowAsync, newWindowAsync, newWindowRunningAsync, selectWindowAsync, splitPaneAsync, stopHostTerminals } from "../apps/server/src/terminals/server/windows.ts";
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

test("closing the last pane does not resurrect the window while its pty lingers", async () => {
  // A command that ignores SIGHUP: `pty.kill()` cannot end it promptly, so its host session stays
  // alive after the close. It exits on its own after ~2 s.
  const ready = join(dir, "lingering-ready.txt");
  const id = await newWindowRunningAsync(
    changeId,
    dir,
    `trap '' HUP; echo ready > ${ready}; i=0; while [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done`,
    {},
  );
  // The trap must be installed before the signal, or the default SIGHUP ends the shell first.
  await waitFor("the shell to ignore SIGHUP", async () => await Bun.file(ready).exists(), 15_000);
  await closePaneAsync(changeId, id, id);
  expect(registry.records(changeId).some((entry) => entry.id === id)).toBe(false);
  // The tombstone is persisted with the registry, so a restart does not re-adopt the lingering pty.
  expect(registry.closedIds()).toContain(id);
  // The lingering session is alive; a rebuild must not re-adopt it and recreate the window.
  expect((await (await hostClient()).list()).some((entry) => entry.id === id && entry.alive)).toBe(true);
  const windows = await listWindowsAsync(changeId);
  expect(windows.some((window) => window.id === id)).toBe(false);
  expect(registry.records(changeId).some((entry) => entry.id === id)).toBe(false);
}, 60_000);

test("adopts a live pane whose window exists, so a crash mid-split leaves no orphan", async () => {
  const window = await newWindowAsync(changeId, dir);
  // A split that opened its host session but crashed before saving its record: the pane's metadata
  // names the window, so a rebuild adopts it instead of leaving an invisible, immortal shell.
  const orphan = randomUUID();
  await (await hostClient()).open(orphan, {
    cwd: dir,
    command: ["/bin/sh"],
    cols: 80,
    rows: 24,
    metadata: { change: changeId, window: window.id, pane: orphan },
  });
  await listWindowsAsync(changeId);
  const record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toContain(orphan);
  expect(record.activePane).not.toBe(orphan); // adoption does not steal the focus
}, 60_000);

test("keeps a window whose other panes exit while a split is in flight", async () => {
  const window = await newWindowAsync(changeId, dir);
  // The split's session exists (metadata names the window) but the window's own pane exits before
  // the split's record is saved. The record would otherwise drop and orphan the new shell.
  const orphan = randomUUID();
  await (await hostClient()).open(orphan, {
    cwd: dir,
    command: ["/bin/sh"],
    cols: 80,
    rows: 24,
    metadata: { change: changeId, window: window.id, pane: orphan },
  });
  await (await hostClient()).kill(window.id);
  await waitFor(
    "the window's first pane to exit",
    async () => (await (await hostClient()).list()).some((entry) => entry.id === window.id && !entry.alive),
    15_000,
  );
  await listWindowsAsync(changeId);
  const record = registry.records(changeId).find((entry) => entry.id === window.id)!;
  expect(record.panes).toEqual([orphan]);
}, 60_000);

test("closing the first pane of a split keeps the window id and releases the first pane's screen", async () => {
  const window = await newWindowRunningAsync(changeId, dir, "echo KEEPME; sleep 30", {
    keepOpen: true,
    announce: { label: "Kept", notify: false },
  });
  await splitPaneAsync(changeId, window, "right");
  const first = window; // the first pane's session id is the window id
  expect(isKeptOpen(changeId, first)).toBe(true);

  await closePaneAsync(changeId, window, first);
  const record = registry.records(changeId).find((entry) => entry.id === window)!;
  // The window id is stable; the closed first pane's screen is released, the survivor's is kept.
  expect(record.panes).not.toContain(first);
  expect(isKeptOpen(changeId, first)).toBe(false);
  expect(isKeptOpen(changeId, record.activePane)).toBe(true);
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
  await waitFor(
    "the change's host sessions to be gone",
    async () => (await (await hostClient()).list()).every((session) => session.metadata?.change !== changeId || !session.alive),
    15_000,
  );
}, 30_000);
