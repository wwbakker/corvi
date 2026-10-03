import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { closeHostClient, hostClient } from "../apps/server/src/terminals/server/host.ts";
import {
  closeAttachments,
  openSession,
  terminalSockets,
  type TerminalSession,
} from "../apps/server/src/terminals/server/session.ts";
import { clearSnapshots, setSnapshot, snapshotOf } from "../apps/server/src/terminals/server/snapshots.ts";
import { newSubagentWindowAsync } from "../apps/server/src/terminals/server/windows.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * Adaptive persistence for agent screens. An agent session (`metadata.subagentId`) reprints its
 * whole view when its pty is jiggled, so the server never persists it on the cadence: it attaches
 * (and jiggles) on first view instead, and only a dead kept-open one is written on exit.
 *
 * The fixture TUI (`fixtures/reprint-tui.mjs`) redraws on `SIGWINCH`, so a marker shows whether the
 * jiggle ran. A shell window is the non-reprintable control and stays on the old path.
 */
const savedEnv = {
  CORVI_HOST_RUNTIME: process.env.CORVI_HOST_RUNTIME,
  CORVI_SCREEN_CADENCE_MS: process.env.CORVI_SCREEN_CADENCE_MS,
  CORVI_REPAINT_QUIET_MS: process.env.CORVI_REPAINT_QUIET_MS,
  CORVI_REPAINT_MAX_MS: process.env.CORVI_REPAINT_MAX_MS,
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
// A short quiet period keeps the first-view jiggle fast in tests.
process.env.CORVI_REPAINT_QUIET_MS = "60";
const dir = await testTempDir("reprint");
const fixture = fileURLToPath(new URL("./fixtures/reprint-tui.mjs", import.meta.url));

type Frame = string | Uint8Array;
type FakeSocket = {
  readonly data: { readonly session: TerminalSession };
  readonly frames: Frame[];
  readonly send: (chunk: string | Uint8Array) => void;
  readonly close: () => void;
};
const fakeSocket = (session: TerminalSession): FakeSocket => {
  const frames: Frame[] = [];
  return { data: { session }, frames, send: (chunk) => frames.push(chunk), close: () => undefined };
};
const control = (frames: readonly Frame[]): Record<string, unknown>[] =>
  frames.filter((frame): frame is string => typeof frame === "string").map((frame) => JSON.parse(frame) as Record<string, unknown>);
const firstScreen = (frames: readonly Frame[]): string => String(control(frames)[0]?.data ?? "");
/** The highest `REPRINT-<n>` marker the screen shows, or 0 for none. */
const maxReprint = (screen: string): number =>
  Math.max(0, ...[...screen.matchAll(/REPRINT-(\d+)/g)].map((match) => Number(match[1])));

/** A subagent window running `command` (the fixture by default), with its incarnation. */
const subagentWindow = async (
  changeId: string,
  command: readonly string[] = ["node", fixture],
): Promise<{ readonly id: string; readonly incarnation: number }> => {
  const id = await newSubagentWindowAsync(changeId, {
    changeDir: dir,
    cwd: dir,
    subagentId: `sub-${changeId}`,
    label: "Agent",
    command,
  });
  const entry = (await (await hostClient()).list()).find((candidate) => candidate.id === id);
  return { id, incarnation: entry?.incarnation ?? 0 };
};

afterEach(() => {
  closeAttachments();
  clearSnapshots();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
});

test("a live reprintable hub never seeds from the store", async () => {
  const change = "REPRINT-SEED";
  const { id, incarnation } = await subagentWindow(change);
  // Drop the hub the window opened, then plant a stored screen: a live reprintable hub must ignore
  // it and build its view from the host ring instead.
  closeAttachments();
  setSnapshot(id, incarnation, "BOGUS-SEED", 123);

  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);

  const screen = firstScreen(ws.frames);
  expect(screen).toContain("REPRINT-BASE"); // the ring replay is the base
  expect(screen).not.toContain("BOGUS-SEED"); // the store was never read
  // The stored entry is untouched: the hub wrote nothing of its own.
  expect(snapshotOf(id, incarnation)?.data).toBe("BOGUS-SEED");
}, 30_000);

test("a live reprintable hub writes nothing across several cadences while dirty", async () => {
  process.env.CORVI_SCREEN_CADENCE_MS = "150";
  try {
    const change = "REPRINT-CADENCE";
    const { id, incarnation } = await subagentWindow(change);
    const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
    const ws = fakeSocket(session);
    terminalSockets.open(ws);
    await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
    // The jiggle and ring made the screen dirty; several cadences must still write nothing.
    await Bun.sleep(600);
    expect(snapshotOf(id, incarnation)).toBeUndefined();
  } finally {
    delete process.env.CORVI_SCREEN_CADENCE_MS;
  }
}, 30_000);

test("a live reprintable hub reprints on first view and not on a second", async () => {
  const change = "REPRINT-JIGGLE";
  const { id } = await subagentWindow(change);
  // Match the window's default size, so `openSession`'s fit is a no-op and only the first-view
  // jiggle makes the fixture redraw.
  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const first = fakeSocket(session);
  terminalSockets.open(first);
  await waitFor("the first snapshot", async () => control(first.frames).some((frame) => frame.type === "snapshot"), 15_000);
  const firstMax = maxReprint(firstScreen(first.frames));
  expect(firstScreen(first.frames)).toContain("REPRINT-BASE");
  expect(firstMax).toBeGreaterThanOrEqual(1); // the jiggle made it reprint
  session.kill();

  const second = fakeSocket(session);
  terminalSockets.open(second);
  await waitFor("the second snapshot", async () => control(second.frames).some((frame) => frame.type === "snapshot"), 15_000);
  // A later view reuses the live hub: no second jiggle, no newer marker.
  expect(maxReprint(firstScreen(second.frames))).toBe(firstMax);
}, 30_000);

test("a dead kept-open reprintable hub persists on exit and seeds on restore", async () => {
  const change = "REPRINT-DEAD";
  const { id, incarnation } = await subagentWindow(change, [
    "/bin/sh",
    "-c",
    "echo DEAD-REPRINT-MARK; sleep 1.5",
  ]);
  // A record that asks to be kept open, the way a command window's can be.
  registry.save(
    change,
    registry.records(change).map((record) => (record.id === id ? { ...record, keepOpen: true } : record)),
  );

  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);

  // The session exits: a kept-open reprintable hub has nothing to reprint, so its final screen is
  // written to the store.
  await waitFor(
    "the frozen screen in the store",
    async () => snapshotOf(id, incarnation)?.data.includes("DEAD-REPRINT-MARK") === true,
    15_000,
  );

  // A restart: the hub is gone, the host session is dead, and the page reopens it from the store.
  closeAttachments();
  const restored = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const again = fakeSocket(restored);
  terminalSockets.open(again);
  await waitFor("the restored snapshot", async () => control(again.frames).some((frame) => frame.type === "snapshot"), 15_000);
  expect(firstScreen(again.frames)).toContain("DEAD-REPRINT-MARK");
}, 30_000);
