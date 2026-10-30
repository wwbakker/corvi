import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { closeHostClient, hostClient } from "../apps/server/src/terminals/server/host.ts";
import {
  applyCutoffForTest,
  closeAttachments,
  holdChunkForTest,
  hubGrid,
  hubStats,
  openSession,
  setReceivedForTest,
  terminalSockets,
  type TerminalSession,
} from "../apps/server/src/terminals/server/session.ts";
import { clearSnapshots, setSnapshot, snapshotOf } from "../apps/server/src/terminals/server/snapshots.ts";
import { newSubagentWindowAsync } from "../apps/server/src/terminals/server/windows.ts";
import * as registry from "../apps/server/src/terminals/server/registry.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * Warm agent screens and the one remaining reprint: a host-ring gap. Every screen attaches at
 * window open and stays warm, so the first view of a long-running agent is a serialize-and-send.
 * Only a `truncated` host replay makes the screen untrustworthy, and then the first view after the
 * gap jiggles the pty once to reprint it.
 *
 * The fixture TUI (`fixtures/reprint-tui.mjs`) redraws on `SIGWINCH`, so a numbered marker shows
 * whether the jiggle ran.
 */
const savedEnv = {
  CORVI_HOST_RUNTIME: process.env.CORVI_HOST_RUNTIME,
  CORVI_HOST_REPLAY_BYTES: process.env.CORVI_HOST_REPLAY_BYTES,
  CORVI_SCREEN_CADENCE_MS: process.env.CORVI_SCREEN_CADENCE_MS,
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
// Keep the host's replay ring tiny: the gap tests deliberately outrun it. The production default
// is 4 MiB.
process.env.CORVI_HOST_REPLAY_BYTES = "1024";
const dir = await testTempDir("reprint");
const fixture = fileURLToPath(new URL("./fixtures/reprint-tui.mjs", import.meta.url));
const fixtureBase = "REPRINT-BASE\r\n";

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
/** The live bytes after the snapshot, as text. */
const liveText = (frames: readonly Frame[]): string =>
  frames
    .filter((frame): frame is Uint8Array => typeof frame !== "string")
    .map((frame) => Buffer.from(frame).toString("utf8"))
    .join("");
/** The page's screen as the snapshot plus the live reprint bytes that followed it. */
const pageText = (frames: readonly Frame[]): string => firstScreen(frames) + liveText(frames);
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

const lastSeq = async (sessionId: string): Promise<number> =>
  (await (await hostClient()).list()).find((entry) => entry.id === sessionId)?.lastSeq ?? 0;

const paddingBytes = 4096;
/** A window that prints the fixture's base, overruns the tiny host ring, then runs the fixture so
 * its SIGWINCH redraw is visible. */
const gapCommand = (): string[] => [
  "/bin/sh",
  "-c",
  `printf 'REPRINT-BASE\\r\\n'; head -c ${paddingBytes} /dev/zero | tr '\\0' X; exec node ${JSON.stringify(fixture)}`,
];

/** Open a gap window, wait for its padding to evict the base from the host ring, then drop the
 * warm hub and any cadence entry. The next open starts at offset 0 and hits the gap. */
const gapWindow = async (changeId: string): Promise<{ readonly id: string; readonly incarnation: number }> => {
  const opened = await subagentWindow(changeId, gapCommand());
  await waitFor(
    "the gap padding and the fixture base",
    // The shell prints its own base before the padding, then the fixture prints another after it.
    // Wait for the fixture's own base so its SIGWINCH handler is installed before a view can
    // trigger the reprint.
    async () => (await lastSeq(opened.id)) >= paddingBytes + 2 * fixtureBase.length,
    20_000,
  );
  closeAttachments();
  clearSnapshots();
  return opened;
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

test("a warm unviewed screen serves without a reprint", async () => {
  const change = "REPRINT-WARM";
  const { id, incarnation } = await subagentWindow(change);
  await waitFor("the fixture base", async () => (await lastSeq(id)) >= fixtureBase.length, 15_000);
  // The window opened its screen and attached it: the first view is a serialize-and-send, with no
  // pty jiggle and so no numbered marker.
  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
  expect(firstScreen(ws.frames)).toContain("REPRINT-BASE");
  expect(maxReprint(firstScreen(ws.frames))).toBe(0);
  expect(hubStats()).toMatchObject({ hubs: 1, attached: 1, subscribers: 1, serves: 1, reprints: 0 });
  expect(hubStats().attaches).toBeGreaterThanOrEqual(1);
  expect(hubGrid(id, incarnation)).toBeDefined();
  const [screenStats] = hubStats().screens;
  expect(screenStats).toMatchObject({ id, incarnation, cols: 100, rows: 30 });
  expect(screenStats!.bufferRows).toBeGreaterThan(0);
  expect(screenStats!.estimatedBytes).toBeGreaterThan(0);
  expect(screenStats!.serializedBytes).toBeGreaterThan(0);
}, 30_000);

test("a warm unviewed agent screen is persisted on the cadence", async () => {
  process.env.CORVI_SCREEN_CADENCE_MS = "200";
  try {
    const change = "REPRINT-CADENCE";
    const { id, incarnation } = await subagentWindow(change);
    // No page ever attaches: the warm screen is still dirty and the uniform cadence persists it.
    await waitFor(
      "the cadence snapshot",
      async () => (snapshotOf(id, incarnation)?.data ?? "").includes("REPRINT-BASE"),
      15_000,
    );
    expect(hubStats()).toMatchObject({ serves: 0, reprints: 0 });
    expect(hubStats().persists).toBeGreaterThanOrEqual(1);
    const [screenStats] = hubStats().screens;
    expect(screenStats?.persists).toBeGreaterThanOrEqual(1);
    expect(screenStats?.serializedBytes).toBeGreaterThan(0);
    expect(screenStats?.lastPersistMs).toBeGreaterThanOrEqual(0);
  } finally {
    delete process.env.CORVI_SCREEN_CADENCE_MS;
  }
}, 30_000);

test("an agent hub seeds from the store like any other screen", async () => {
  const change = "REPRINT-SEED";
  const { id, incarnation } = await subagentWindow(change);
  await waitFor("the fixture base", async () => (await lastSeq(id)) >= fixtureBase.length, 15_000);
  // Drop the hub the window opened, then plant a stored screen: a reopened agent hub is not special
  // and seeds from the store exactly like a shell's screen.
  closeAttachments();
  setSnapshot(id, incarnation, "SEEDED-AGENT-SCREEN", 0);

  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
  const screen = firstScreen(ws.frames);
  expect(screen).toContain("SEEDED-AGENT-SCREEN"); // the stored screen
  expect(screen).toContain("REPRINT-BASE"); // and the ring replay on top
  expect(hubStats().reprints).toBe(0);
}, 30_000);

test("a live seeded agent hub reprints once on a host-ring gap", async () => {
  const change = "REPRINT-SEED-GAP";
  const { id, incarnation } = await gapWindow(change);
  // The seed is a real stored screen for a still-live session, and the attach resumes behind the
  // ring's oldest byte: the gap path must keep the seed and still reprint once.
  setSnapshot(id, incarnation, "SEEDED-GAP-SCREEN", 0);
  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 20_000);
  const screen = firstScreen(ws.frames);
  expect(screen).toContain("SEEDED-GAP-SCREEN");
  expect(maxReprint(screen)).toBe(0); // the snapshot was taken before the reprint was issued
  // The ring replay is live bytes after the snapshot: wait for it there, not in the snapshot.
  await waitFor("the ring tail", async () => pageText(ws.frames).includes("REPRINT-BASE"), 15_000);
  await waitFor("the reprint bytes", async () => maxReprint(pageText(ws.frames)) >= 1, 15_000);
  await waitFor("the reprint counter", async () => hubStats().reprints === 1, 15_000);
  expect(pageText(ws.frames)).toContain("SEEDED-GAP-SCREEN");
  expect(pageText(ws.frames)).toContain("REPRINT-BASE");
  expect(hubStats()).toMatchObject({ serves: 1, reprints: 1 });
}, 30_000);

test("a host-ring gap reprints once and still serves a snapshot", async () => {
  const change = "REPRINT-GAP";
  const { id } = await gapWindow(change);
  // No stored screen, and the attach resumes at offset 0 behind the ring's oldest byte: the replay
  // is truncated, so the first view jiggles the pty and the fixture prints REPRINT-1.
  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  const openedAt = Date.now();
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 5_000);
  // The snapshot is not gated on the reprint settling: it is a warm serialize-and-send.
  expect(Date.now() - openedAt).toBeLessThan(3_000);
  const screen = firstScreen(ws.frames);
  expect(screen).toContain("REPRINT-BASE");
  expect(maxReprint(screen)).toBe(0); // the reprint follows the snapshot
  await waitFor("the reprint bytes", async () => maxReprint(pageText(ws.frames)) >= 1, 15_000);
  await waitFor("the reprint counter", async () => hubStats().reprints === 1, 15_000);
  expect(hubStats()).toMatchObject({ hubs: 1, attached: 1, subscribers: 1, serves: 1, reprints: 1 });

  // A second view reuses the warm hub: the gap marker is cleared, so it does not reprint again.
  await Bun.sleep(50); // let the live reprint bytes (including a late REPRINT-2) reach the screen
  const firstMax = maxReprint(pageText(ws.frames));
  session.kill();
  const second = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const again = fakeSocket(second);
  terminalSockets.open(again);
  await waitFor("the second snapshot", async () => control(again.frames).some((frame) => frame.type === "snapshot"), 15_000);
  expect(maxReprint(pageText(again.frames))).toBe(firstMax);
  expect(hubStats()).toMatchObject({ serves: 2, reprints: 1 });
}, 30_000);

test("a gap window that keeps painting still gets a quick snapshot and converges", async () => {
  process.env.REPRINT_PAINT_MS = "40";
  try {
    const change = "REPRINT-PAINTING";
    const { id } = await gapWindow(change);
    const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
    const ws = fakeSocket(session);
    const openedAt = Date.now();
    terminalSockets.open(ws);
    await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 5_000);
    // Continuous output must not gate the view: the snapshot is the warm screen, not a quiet wait.
    expect(Date.now() - openedAt).toBeLessThan(3_000);
    expect(firstScreen(ws.frames)).toContain("REPRINT-BASE");
    await waitFor("the reprint bytes", async () => maxReprint(pageText(ws.frames)) >= 1, 15_000);
    await waitFor("the reprint counter", async () => hubStats().reprints === 1, 15_000);
    expect(liveText(ws.frames)).toContain("PAINT-");
  } finally {
    delete process.env.REPRINT_PAINT_MS;
  }
}, 30_000);

test("an unviewed gap does not reprint until the first view, and counters reset", async () => {
  const change = "REPRINT-UNVIEWED-GAP";
  const { id } = await subagentWindow(change, gapCommand());
  await waitFor(
    "the gap padding and the fixture base",
    async () => (await lastSeq(id)) >= paddingBytes + fixtureBase.length,
    20_000,
  );
  // The window is warm with no page. Its startup replay was complete, so the ring gap alone must
  // not issue a reprint for an unseen screen.
  expect(hubStats()).toMatchObject({ hubs: 1, attached: 1, subscribers: 0, serves: 0, reprints: 0 });

  closeAttachments();
  clearSnapshots();
  expect(hubStats()).toMatchObject({ hubs: 0, serves: 0, reprints: 0, attaches: 0, persists: 0, screens: [] });

  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the first view", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 20_000);
  await waitFor("the reprint counter", async () => hubStats().reprints === 1, 15_000);
  expect(hubStats().serves).toBe(1);
  expect(hubStats().attaches).toBeGreaterThanOrEqual(1);

  closeAttachments();
  expect(hubStats()).toMatchObject({
    hubs: 0,
    attached: 0,
    subscribers: 0,
    serves: 0,
    reprints: 0,
    attaches: 0,
    persists: 0,
    lastServeMs: 0,
    lastReprintMs: 0,
    lastAttachMs: 0,
    lastPersistMs: 0,
    screens: [],
  });
}, 30_000);

test("the trace emits a per-hub screen line without serializing", async () => {
  const saved = {
    CORVI_TERMINAL_TRACE: process.env.CORVI_TERMINAL_TRACE,
    CORVI_TERMINAL_TRACE_MS: process.env.CORVI_TERMINAL_TRACE_MS,
    CORVI_LOG: process.env.CORVI_LOG,
  };
  const logPath = `${dir}/trace-${Date.now()}.log`;
  try {
    process.env.CORVI_TERMINAL_TRACE = "1";
    process.env.CORVI_TERMINAL_TRACE_MS = "0";
    process.env.CORVI_LOG = logPath;
    const { id } = await subagentWindow("REPRINT-TRACE");
    await waitFor("the fixture base", async () => (await lastSeq(id)) >= fixtureBase.length, 15_000);
    await waitFor(
      "the per-hub screen trace",
      async () => (await Bun.file(logPath).text().catch(() => "")).includes("[terminals] screen"),
      15_000,
    );
    const logged = await Bun.file(logPath).text();
    expect(logged).toContain(`screen ${id}#`);
    expect(logged).toContain("grid=");
    expect(logged).toContain("bufferRows=");
    expect(logged).toContain("estBytes=");
    expect(logged).toContain("lastPersistMs=");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);

test("a dead kept-open hub persists on exit and seeds on restore", async () => {
  const change = "REPRINT-DEAD";
  const { id, incarnation } = await subagentWindow(change, [
    "/bin/sh",
    "-c",
    // The marker first, so the warm screen captures it, then enough output to evict it from the
    // host ring — the frozen screen must come from the store on restore, not from the ring replay.
    "echo DEAD-REPRINT-MARK; sleep 3; head -c 320000 /dev/zero | tr '\\0' X; sleep 0.3",
  ]);
  // A record that asks to be kept open, the way a command window's can be.
  registry.save(
    change,
    registry.records(change).map((record) => (record.id === id ? { ...record, keepOpen: true } : record)),
  );

  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  // Served: a snapshot, or a reset when the shell has not printed the marker yet — the window was
  // opened a moment ago, and a slower shell start (macOS) loses that race. Either way the warm
  // screen captures the marker, which is what the store must keep.
  await waitFor(
    "the first serve",
    async () => control(ws.frames).some((frame) => frame.type === "snapshot" || frame.type === "reset"),
    15_000,
  );

  // The session exits: its final screen is written to the store even though the window is kept open.
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

test("a second open during a background gap reprint supersedes, with one reprint and no exit", async () => {
  process.env.REPRINT_DELAY_MS = "500";
  try {
    const change = "REPRINT-QUEUE";
    // The delay is read when the fixture starts, so it must be set before the window opens.
    const { id } = await gapWindow(change);
    const first = await openSession(change, dir, { cols: 100, rows: 30 }, id);
    const one = fakeSocket(first);
    terminalSockets.open(one); // starts the first view; its delayed reprint follows the snapshot
    await waitFor(
      "the first snapshot",
      async () => control(one.frames).some((frame) => frame.type === "snapshot"),
      15_000,
    );
    // The background reprint no longer holds the attach, so this is an ordinary supersede: the
    // first page leaves while the reprint is in flight, and the second is served a snapshot plus
    // the reprint bytes. It must not be told the session ended, and the reprint runs once.
    first.kill();
    const second = await openSession(change, dir, { cols: 100, rows: 30 }, id);
    const two = fakeSocket(second);
    terminalSockets.open(two);
    await waitFor(
      "the queued snapshot",
      async () => control(two.frames).some((frame) => frame.type === "snapshot"),
      20_000,
    );
    // Served, never told the session is gone.
    expect(control(two.frames).some((frame) => frame.type === "exit")).toBe(false);
    expect(hubStats().subscribers).toBe(1);
    await waitFor("the reprint bytes", async () => maxReprint(pageText(two.frames)) >= 1, 15_000);
    await waitFor("the reprint counter", async () => hubStats().reprints === 1, 15_000);
  } finally {
    delete process.env.REPRINT_DELAY_MS;
  }
}, 30_000);

test("bytes held when a page leaves mid-snapshot are still fed, so the next view is served", async () => {
  const change = "REPRINT-DRAIN";
  const session = await openSession(change, dir, { cols: 80, rows: 24 });
  const id = session.sessionId;
  const incarnation = session.incarnation;
  // A cutoff the screen has not reached keeps the serve waiting with its hold open (the real race
  // is narrow; the seams stage it exactly).
  setReceivedForTest(id, incarnation, 1000);
  const one = fakeSocket(session);
  terminalSockets.open(one);
  let held = false;
  for (let i = 0; i < 2000 && !held; i++) {
    held = holdChunkForTest(id, incarnation, 1010, "DRAIN-HELD\r\n");
    if (!held) await Bun.sleep(1);
  }
  expect(held).toBe(true);
  // The page leaves mid-snapshot; the held chunk must still reach the screen, or the next serve's
  // `whenApplied` waits on a byte the screen never saw.
  session.kill();
  applyCutoffForTest(id, incarnation, 1000, "CUTOFF");
  const second = await openSession(change, dir, { cols: 80, rows: 24 });
  const two = fakeSocket(second);
  terminalSockets.open(two);
  await waitFor("the second snapshot", async () => control(two.frames).some((frame) => frame.type === "snapshot"), 15_000);
  expect(firstScreen(two.frames)).toContain("DRAIN-HELD");
}, 30_000);

test("a send that throws mid-replay still leaves the rest of the hold for the screen", async () => {
  const change = "REPRINT-SEND";
  const session = await openSession(change, dir, { cols: 80, rows: 24 });
  const id = session.sessionId;
  const incarnation = session.incarnation;
  setReceivedForTest(id, incarnation, 1000);
  // A socket whose first send throws: the happy path's replay loop must leave the remaining held
  // chunks for the finally to drain, not lose them with the local batch.
  let sent = 0;
  const throwing: FakeSocket = {
    data: { session },
    frames: [],
    send: () => {
      sent += 1;
      // The first send is the snapshot; the second is the first held chunk.
      if (sent === 2) throw new Error("send exploded");
    },
    close: () => undefined,
  };
  terminalSockets.open(throwing);
  let held = 0;
  for (let i = 0; i < 4000 && held < 2; i++) {
    if (held === 0 && holdChunkForTest(id, incarnation, 1010, "SEND-HELD-1\r\n")) held = 1;
    else if (held === 1 && holdChunkForTest(id, incarnation, 1030, "SEND-HELD-2\r\n")) held = 2;
    if (held < 2) await Bun.sleep(1);
  }
  expect(held).toBe(2);
  // Let the serve reach its cutoff; its replay sends the first held chunk, which throws.
  applyCutoffForTest(id, incarnation, 1000, "CUTOFF");
  await Bun.sleep(50);
  const second = await openSession(change, dir, { cols: 80, rows: 24 });
  const two = fakeSocket(second);
  terminalSockets.open(two);
  await waitFor("the second snapshot", async () => control(two.frames).some((frame) => frame.type === "snapshot"), 15_000);
  // The chunk the throw skipped still reached the screen, so the next serve could serialize past it.
  expect(firstScreen(two.frames)).toContain("SEND-HELD-2");
}, 30_000);

test("a page that leaves mid-reprint leaves no ghost subscriber", async () => {
  process.env.REPRINT_DELAY_MS = "500";
  try {
    const change = "REPRINT-GHOST";
    const { id } = await gapWindow(change);
    const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
    const ws = fakeSocket(session);
    terminalSockets.open(ws);
    await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
    session.kill(); // leave while the delayed gap reprint is still running
    await waitFor("the page to leave", async () => hubStats().subscribers === 0, 15_000);
    // The screen stays warm: no page is attached, but the hub and its host attachment remain.
    expect(hubStats()).toMatchObject({ hubs: 1, attached: 1, subscribers: 0 });
  } finally {
    delete process.env.REPRINT_DELAY_MS;
  }
}, 30_000);

test("a session exit during a reprint disposes the hub and does not count a reprint", async () => {
  const change = "REPRINT-EXIT";
  const { id, incarnation } = await gapWindow(change);
  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const snapshots: string[] = [];
  let stopped: "exit" | "detached" | undefined;
  session.attach(
    () => undefined,
    (frame) => {
      snapshots.push(frame.data);
      // Hold the background reprint at its pre-jiggle applied-byte wait, so the exit lands while
      // it is in flight.
      setReceivedForTest(id, incarnation, 1_000_000);
    },
    (reason) => {
      stopped = reason;
    },
  );
  await waitFor("the snapshot", async () => snapshots.length > 0, 15_000);
  await waitFor("the reprint to be in flight", async () => hubStats().screens[0]?.reprinting === true, 10_000);
  await (await hostClient()).kill(id);
  await waitFor("the hub to be disposed", async () => hubStats().hubs === 0, 15_000);
  expect(stopped).toBe("exit");
  // The interrupted reprint never jiggled to completion, so it is not counted; no ghost subscriber
  // and no disposed screen remain.
  expect(hubStats()).toMatchObject({ hubs: 0, attached: 0, subscribers: 0, reprints: 0 });
}, 30_000);

test("a resize around a gap reprint ends at the latest grid", async () => {
  const change = "REPRINT-RESIZE";
  const { id, incarnation } = await gapWindow(change);
  const session = await openSession(change, dir, { cols: 100, rows: 30 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the snapshot", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 20_000);
  // The snapshot is already on its way; the reprint follows it. A refit now must win over the
  // reprint's captured size and leave both the pty and the screen at the latest grid.
  session.resize(90, 30);
  await waitFor("the grid to settle", async () => hubGrid(id, incarnation)?.cols === 90, 10_000);
  expect(hubGrid(id, incarnation)?.cols).toBe(90);
  await waitFor("the reprint bytes", async () => maxReprint(pageText(ws.frames)) >= 1, 15_000);
  await waitFor("the reprint counter", async () => hubStats().reprints === 1, 15_000);
  // The completion must not leave the grid at the reprint's transient size.
  expect(hubGrid(id, incarnation)?.cols).toBe(90);
}, 30_000);
