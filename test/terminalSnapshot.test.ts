import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "@corvi/configuration/node";

import { hostClient, closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { closeAttachments, flushScreens, hubStats, openSession, terminalSockets, type TerminalSession } from "../apps/server/src/terminals/server/session.ts";
import { makeScreen, SCREEN_SCROLLBACK } from "../apps/server/src/terminals/server/screen.ts";
import { keptOpenPanes, liveSnapshotKeys, newWindowRunningAsync } from "../apps/server/src/terminals/server/windows.ts";
import {
  SNAPSHOT_MAX_BYTES,
  clearSnapshots,
  loadSnapshots,
  pruneSnapshots,
  setSnapshot,
  snapshotOf,
  snapshotStats,
} from "../apps/server/src/terminals/server/snapshots.ts";
import type { WindowRecord } from "../apps/server/src/terminals/server/registry.ts";
import type { SessionInfo } from "../apps/server/src/terminals/server/host.ts";
import { testTempDir, until, waitFor } from "./helpers.ts";

/**
 * The server-owned screen and the hub's snapshot handshake, plus the (still-unused) snapshot
 * store that P2 will seed from.
 *
 * The screen is fed every host byte and serialized to a page; the page gets the snapshot first and
 * the live bytes after its offset, once. The snapshot store is no longer written by the page —
 * P2 wires server-side persistence — so its own tests stay here until then.
 */
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
const dir = await testTempDir("snapshot");

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => {
  closeAttachments();
  clearSnapshots();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
});

test("the screen applies bytes at their offset and serializes them back", async () => {
  expect(SCREEN_SCROLLBACK).toBe(5000);
  const screen = makeScreen({ cols: 80, rows: 24 });
  screen.write(bytes("SCREEN-MARK\r\n"), 10);
  await screen.whenApplied(10 + "SCREEN-MARK\r\n".length);
  const first = screen.serialize();
  expect(first.data).toContain("SCREEN-MARK");
  expect(first.data.endsWith("\x1b[?25h")).toBe(true);
  expect(first.offset).toBe(10 + "SCREEN-MARK\r\n".length);

  // The offset advances with each chunk, so an attach resumes after exactly what it serialized.
  const more = "AFTER";
  screen.write(bytes(more), first.offset);
  await screen.whenApplied(first.offset + more.length);
  expect(screen.serialize()).toMatchObject({ offset: first.offset + more.length });
  screen.dispose();
});

test("the screen serializes DEC modes and always shows the cursor", async () => {
  const screen = makeScreen({ cols: 80, rows: 24 });
  screen.write(bytes("HELLO\u001b[?2004h\u001b[?25l"), 0);
  await screen.whenApplied(byteLength("HELLO\u001b[?2004h\u001b[?25l"));
  const { data } = screen.serialize();
  // The addon re-emits bracketed paste but not DECTCEM; the screen adds the cursor itself.
  expect(data).toContain("\u001b[?2004h");
  expect(data.endsWith("\u001b[?25h")).toBe(true);
  screen.dispose();
});

test("the screen re-asserts the mouse encoding the serialize addon omits", async () => {
  // The addon emits the tracking mode but not the encoding; the screen adds it back so a page that
  // replays the snapshot does not silently fall back to the legacy DEFAULT (X10) encoding.
  const sgr = makeScreen({ cols: 80, rows: 24 });
  sgr.write(bytes("\u001b[?1002h\u001b[?1006h"), 0);
  await sgr.whenApplied(byteLength("\u001b[?1002h\u001b[?1006h"));
  const sgrData = sgr.serialize().data;
  expect(sgrData).toContain("\u001b[?1002h");
  expect(sgrData).toContain("\u001b[?1006h");
  sgr.dispose();

  // SGR-pixels is the other non-default encoding.
  const pixels = makeScreen({ cols: 80, rows: 24 });
  pixels.write(bytes("\u001b[?1002h\u001b[?1016h"), 0);
  await pixels.whenApplied(byteLength("\u001b[?1002h\u001b[?1016h"));
  expect(pixels.serialize().data).toContain("\u001b[?1016h");
  pixels.dispose();

  // Tracking with the DEFAULT encoding: no encoding sequence is invented.
  const legacy = makeScreen({ cols: 80, rows: 24 });
  legacy.write(bytes("\u001b[?1002h"), 0);
  await legacy.whenApplied(byteLength("\u001b[?1002h"));
  const legacyData = legacy.serialize().data;
  expect(legacyData).toContain("\u001b[?1002h");
  expect(legacyData).not.toContain("\u001b[?1006h");
  expect(legacyData).not.toContain("\u001b[?1016h");
  legacy.dispose();

  // No mouse mode at all: no encoding either.
  const none = makeScreen({ cols: 80, rows: 24 });
  none.write(bytes("PLAIN"), 0);
  await none.whenApplied(byteLength("PLAIN"));
  const noneData = none.serialize().data;
  expect(noneData).not.toContain("\u001b[?1006h");
  expect(noneData).not.toContain("\u001b[?1016h");
  none.dispose();
});

test("an empty screen serializes to nothing, and resize follows the page", () => {
  const screen = makeScreen({ cols: 80, rows: 24 });
  expect(screen.serialize()).toEqual({ data: "", offset: 0, truncated: false });
  screen.resize(120, 40);
  expect(screen.cols).toBe(120);
  expect(screen.rows).toBe(40);
  screen.dispose();
});

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The host's emitted byte offset for a session (monotonic). */
const lastSeq = async (sessionId: string): Promise<number> =>
  (await (await hostClient()).list()).find((entry) => entry.id === sessionId)?.lastSeq ?? 0;

/** Write a command once the shell's prompt has settled, then wait until the host has emitted the
 * command's echo *and* its output. The settle makes the byte delta unambiguous: the echo is
 * `command.length` bytes, so waiting past it plus the output line means the marker reached the
 * screen. */
const runAndWait = async (
  session: { sessionId: string; write: (data: string) => void },
  command: string,
): Promise<void> => {
  let previous = -1;
  await waitFor(
    "the shell's prompt to settle",
    async () => {
      const now = await lastSeq(session.sessionId);
      const stable = now > 0 && now === previous;
      previous = now;
      return stable;
    },
    15_000,
  );
  session.write(command);
  await waitFor(
    "the host to emit the command's output",
    async () => (await lastSeq(session.sessionId)) >= previous + command.length + 12,
    15_000,
  );
};

type FakeSocket = {
  readonly data: { readonly session: TerminalSession };
  readonly frames: (string | Uint8Array)[];
  readonly send: (chunk: string | Uint8Array) => void;
  readonly close: () => void;
  /** The queued-bytes figure the backpressure check reads; a test sets it to simulate a slow page. */
  bufferedAmount: number;
  /** Whether the backpressure path closed this socket. */
  readonly closed: () => boolean;
  /** How many times it was closed: the grace must yield one per window, not one per byte. */
  readonly closeCount: () => number;
};
const fakeSocket = (session: TerminalSession): FakeSocket => {
  const frames: (string | Uint8Array)[] = [];
  let closes = 0;
  const socket: FakeSocket = {
    data: { session },
    frames,
    send: (chunk) => frames.push(chunk),
    close: () => {
      closes += 1;
      // The server's own close path, so the hub stops sending to a socket the backpressure closed.
      terminalSockets.close(socket);
    },
    bufferedAmount: 0,
    closed: () => closes > 0,
    closeCount: () => closes,
  };
  return socket;
};
const text = (frames: (string | Uint8Array)[]): string =>
  frames
    .filter((frame): frame is Uint8Array => typeof frame !== "string")
    .map((frame) => Buffer.from(frame).toString("utf8"))
    .join("");
const control = (frames: (string | Uint8Array)[]): Record<string, unknown>[] =>
  frames.filter((frame): frame is string => typeof frame === "string").map((frame) => JSON.parse(frame) as Record<string, unknown>);

test("a page gets the server's snapshot first, then the live bytes after its offset", async () => {
  const session = await openSession("SNAP-1", dir, { cols: 80, rows: 24 });
  const command = "echo FIRST_$(( 0 + 1 ))_MARK\n";
  await runAndWait(session, command);
  const first = fakeSocket(session);
  terminalSockets.open(first);
  await waitFor("the snapshot frame", async () => control(first.frames).some((frame) => frame.type === "snapshot"), 15_000);
  const opening = control(first.frames);
  expect(opening).toHaveLength(1);
  expect(opening[0]).toMatchObject({ type: "snapshot", incarnation: session.incarnation, sessionId: session.sessionId });
  expect(opening[0]?.data).toContain("FIRST_1_MARK");

  // Bytes produced after the snapshot arrive live, exactly once.
  session.write("echo SECOND_$(( 0 + 1 ))_MARK\n");
  await waitFor("the live bytes", async () => text(first.frames).includes("SECOND_1_MARK"), 15_000);
  expect(text(first.frames).split("SECOND_1_MARK").length - 1).toBe(1);
}, 30_000);

test("the backpressure bound closes a page that stops draining, without an exit", async () => {
  const session = await openSession("SNAP-BP", dir, { cols: 80, rows: 24 });
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the opening frame", async () => control(ws.frames).some((frame) => frame.type === "snapshot" || frame.type === "reset"), 15_000);
  // A send with the queue under the bound arms the steady-state bound.
  await runAndWait(session, "echo BP_ARM\n");
  await waitFor("the armed chunk", async () => text(ws.frames).includes("BP_ARM"), 15_000);
  expect(ws.closed()).toBe(false);

  // The page stops reading: the next live byte is not queued behind it without bound.
  ws.bufferedAmount = (1 << 20) + 1;
  session.write("echo BP_OVER\n");
  await waitFor("the lagging socket to close", async () => ws.closed(), 15_000);
  expect(ws.closeCount()).toBe(1);
  // No `exit`: the page must reconnect to a fresh snapshot, not treat the session as gone.
  expect(control(ws.frames).some((frame) => frame.type === "exit")).toBe(false);
  expect(text(ws.frames)).not.toContain("BP_OVER");
}, 30_000);

test("the backpressure grace defers the close, then allows one per grace window", async () => {
  process.env.CORVI_BACKPRESSURE_GRACE_MS = "400";
  try {
    const session = await openSession("SNAP-BP-GRACE", dir, { cols: 80, rows: 24 });
    const ws = fakeSocket(session);
    // Over the bound from the first live byte: a large snapshot draining on a slow link.
    ws.bufferedAmount = (1 << 20) + 1;
    terminalSockets.open(ws);
    await waitFor("the opening frame", async () => control(ws.frames).some((frame) => frame.type === "snapshot" || frame.type === "reset"), 15_000);
    session.write("echo BP_EARLY\n");
    await waitFor("the chunk inside the grace", async () => text(ws.frames).includes("BP_EARLY"), 15_000);
    expect(ws.closed()).toBe(false); // deferred: the snapshot is still draining

    await Bun.sleep(500); // past the grace
    session.write("echo BP_LATE\n");
    await waitFor("the socket to close after the grace", async () => ws.closed(), 15_000);
    expect(ws.closeCount()).toBe(1);
    expect(control(ws.frames).some((frame) => frame.type === "exit")).toBe(false);
  } finally {
    delete process.env.CORVI_BACKPRESSURE_GRACE_MS;
  }
}, 30_000);

test("a session that exits while attached tells the page before closing", async () => {
  const session = await openSession("SNAP-EXIT", dir, { cols: 80, rows: 24 });
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  session.write("echo EXIT_$(( 0 + 1 ))_MARK\n");
  await waitFor("the output", async () => text(ws.frames).includes("EXIT_1_MARK"), 15_000);

  const client = await hostClient();
  await client.kill(session.sessionId);
  await waitFor("the exit frame", async () => control(ws.frames).some((frame) => frame.type === "exit"), 15_000);
}, 30_000);

test("a second page over one session detaches the first with a detached frame, not an exit", async () => {
  const first = await openSession("SNAP-DETACHED", dir, { cols: 80, rows: 24 });
  const one = fakeSocket(first);
  terminalSockets.open(one);
  await waitFor(
    "the first opening frame",
    async () => control(one.frames).some((frame) => frame.type === "snapshot" || frame.type === "reset"),
    15_000,
  );

  // A second socket over the same session supersedes the first with a frame that says so, then
  // closes it. The page reads that as "take it back", not as the session ending.
  const second = await openSession("SNAP-DETACHED", dir, { cols: 80, rows: 24 });
  const two = fakeSocket(second);
  terminalSockets.open(two);
  await waitFor("the detached frame", async () => control(one.frames).some((frame) => frame.type === "detached"), 15_000);
  expect(control(one.frames).some((frame) => frame.type === "exit")).toBe(false);
  expect(one.closed()).toBe(true);
  await waitFor(
    "the second opening frame",
    async () => control(two.frames).some((frame) => frame.type === "snapshot" || frame.type === "reset"),
    15_000,
  );
}, 30_000);

test("a session that exits with no page releases its screen when not kept open", async () => {
  const session = await openSession("SNAP-DETACH", dir, { cols: 80, rows: 24 });
  expect(hubStats().hubs).toBe(1);
  const client = await hostClient();
  await client.kill(session.sessionId);
  // A non-kept-open window's frozen screen is not wanted; P2 owns the full policy.
  await waitFor("the hub to clear on a detached exit", async () => hubStats().hubs === 0, 15_000);
}, 30_000);

test("a dead kept-open window's screen is served on a later attach", async () => {
  const change = "SNAP-DEAD";
  const changeDir = join(process.env.CORVI_ROOT ?? dir, change);
  await mkdir(changeDir, { recursive: true });
  // A kept-open command window whose pty has already exited: opening its terminal must show what
  // it printed, which now comes from the hub's screen replay of the host ring.
  const id = await newWindowRunningAsync(change, changeDir, "echo DEAD_$(( 0 + 1 ))_MARK", {
    keepOpen: true,
    announce: { label: "Dead", notify: true },
  });
  await waitFor(
    "the command to finish",
    async () => (await (await hostClient()).list()).some((entry) => entry.id === id && !entry.alive),
    15_000,
  );

  const session = await openSession(change, changeDir, { cols: 80, rows: 24 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the dead screen", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
  expect(control(ws.frames)[0]?.data).toContain("DEAD_1_MARK");
  // The session is dead and the page is told so, but the window asked to be kept open: its screen
  // stays for the next look rather than being evicted with the rest.
  await waitFor("the exit frame", async () => control(ws.frames).some((frame) => frame.type === "exit"), 15_000);
  expect(hubStats().hubs).toBe(1);
}, 30_000);

test("a stored screen is seeded and the ring applies on top when the ring has a gap", async () => {
  const change = "SNAP-GAP";
  const changeDir = join(process.env.CORVI_ROOT ?? dir, change);
  await mkdir(changeDir, { recursive: true });
  const id = await newWindowRunningAsync(
    change,
    changeDir,
    "echo RING-TAIL; head -c 320000 /dev/zero | tr '\\0' X; echo GAP-DONE",
    { keepOpen: true, announce: { label: "Gap", notify: true } },
  );
  await waitFor(
    "the command to finish",
    async () => (await (await hostClient()).list()).some((entry) => entry.id === id && !entry.alive),
    15_000,
  );
  const incarnation = (await (await hostClient()).list()).find((entry) => entry.id === id)?.incarnation ?? 0;

  // A stored screen ending in a deep marker, at offset 0 — before the ring's oldest byte, so the
  // host cannot replay from it. The policy keeps the deep screen and lets the ring land on top.
  // Dispose the hub the window was opened with, so the next `openSession` is the restart path.
  closeAttachments();
  const seed = makeScreen({ cols: 80, rows: 24 });
  seed.write(bytes("DEEP-SEED-MARK\r\n"), 0);
  await seed.whenApplied(byteLength("DEEP-SEED-MARK\r\n"));
  const seeded = seed.serialize();
  seed.dispose();
  setSnapshot(id, incarnation, seeded.data, 0);

  const session = await openSession(change, changeDir, { cols: 80, rows: 24 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the seeded screen", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
  const screen = String(control(ws.frames)[0]?.data ?? "");
  expect(screen).toContain("DEEP-SEED-MARK"); // the store's deep history survives the gap
  expect(screen).toContain("GAP-DONE"); // and the ring's tail landed on top
}, 30_000);

test("the cadence persists a dirty screen", async () => {
  process.env.CORVI_SCREEN_CADENCE_MS = "300";
  try {
    const session = await openSession("SNAP-CADENCE", dir, { cols: 80, rows: 24 });
    const command = "echo CADENCE_MARK\n";
    await runAndWait(session, command);
    await waitFor(
      "the store to fill",
      async () => (snapshotOf(session.sessionId, session.incarnation)?.data ?? "").includes("CADENCE_MARK"),
      15_000,
    );
  } finally {
    delete process.env.CORVI_SCREEN_CADENCE_MS;
  }
}, 30_000);

test("flushScreens writes a dirty screen synchronously", async () => {
  const session = await openSession("SNAP-FLUSH", dir, { cols: 80, rows: 24 });
  const command = "echo FLUSH_MARK\n";
  await runAndWait(session, command);
  flushScreens();
  expect(snapshotOf(session.sessionId, session.incarnation)?.data).toContain("FLUSH_MARK");
}, 30_000);

test("an unattended screen is released and kept in the store", async () => {
  process.env.CORVI_SCREEN_IDLE_MS = "1500";
  try {
    const session = await openSession("SNAP-IDLE", dir, { cols: 80, rows: 24 });
    const command = "echo IDLE_MARK\n";
    await runAndWait(session, command);
    await waitFor("the screen to be released", async () => hubStats().hubs === 0, 15_000);
    // The store keeps it, so a later attach reseeds rather than rebuilds; the shell itself is
    // untouched and still alive.
    expect(snapshotOf(session.sessionId, session.incarnation)?.data).toContain("IDLE_MARK");
    expect((await (await hostClient()).list()).some((entry) => entry.id === session.sessionId && entry.alive)).toBe(true);
  } finally {
    delete process.env.CORVI_SCREEN_IDLE_MS;
  }
}, 30_000);

test("an unattended screen that never stops painting is still released", async () => {
  process.env.CORVI_SCREEN_IDLE_MS = "1500";
  try {
    const session = await openSession("SNAP-BUSY", dir, { cols: 80, rows: 24 });
    session.write("while :; do printf '\\033[2J\\033[H'; yes row | head -24; sleep 0.05; done\n");
    // Prove it is painting, then let the grace pass: output must not postpone the release, or an
    // agent that never stops repainting would be parsed forever with nobody watching.
    await waitFor(
      "the screen to be painting",
      async () => ((await (await hostClient()).list()).find((entry) => entry.id === session.sessionId)?.lastSeq ?? 0) > 1000,
      15_000,
    );
    await waitFor("the unattended screen to be released", async () => hubStats().hubs === 0, 15_000);
    // The shell is untouched — only the server's screen and feed stopped.
    expect((await (await hostClient()).list()).some((entry) => entry.id === session.sessionId && entry.alive)).toBe(true);
  } finally {
    delete process.env.CORVI_SCREEN_IDLE_MS;
  }
}, 30_000);

test("a seeded screen's applied offset never regresses when a ring byte lands behind it", async () => {
  const screen = makeScreen({ cols: 80, rows: 24 });
  screen.seed("SEEDED-SCREEN\r\n", 1000);
  await screen.whenApplied(1000);
  expect(screen.serialize().offset).toBe(1000);
  // The gap policy's case: the host ring replays from an offset behind the seed. The bytes are
  // drawn, but the applied offset must stay at the seed's high-water — a regressed offset would
  // be persisted and the next resume would replay bytes already covered.
  screen.write(bytes("RING-TAIL"), 10);
  await Bun.sleep(50);
  expect(screen.serialize().offset).toBe(1000);
  expect(screen.serialize().data).toContain("RING-TAIL");
  screen.dispose();
});

test("a persisted and reseeded hub resumes from the stored high-water, not the ring", async () => {
  const change = "SNAP-MONO";
  const changeDir = join(process.env.CORVI_ROOT ?? dir, change);
  await mkdir(changeDir, { recursive: true });
  const id = await newWindowRunningAsync(
    change,
    changeDir,
    "echo DEEP-AT-H; head -c 320000 /dev/zero | tr '\\0' X; echo RING-END",
    { keepOpen: true, announce: { label: "Mono", notify: true } },
  );
  await waitFor(
    "the command to finish",
    async () => (await (await hostClient()).list()).some((entry) => entry.id === id && !entry.alive),
    15_000,
  );
  const incarnation = (await (await hostClient()).list()).find((entry) => entry.id === id)?.incarnation ?? 0;
  const emitted = (await (await hostClient()).list()).find((entry) => entry.id === id)?.lastSeq ?? 0;

  // A stored screen at the host's end, holding a deep marker. The ring's oldest byte is far behind
  // it; the hub must claim the stored offset rather than the ring's. Dispose the hub the window
  // was opened with, so this is the restart path.
  closeAttachments();
  const seed = makeScreen({ cols: 80, rows: 24 });
  seed.write(bytes("DEEP-AT-H\r\n"), 0);
  await seed.whenApplied(byteLength("DEEP-AT-H\r\n"));
  const seeded = seed.serialize();
  seed.dispose();
  setSnapshot(id, incarnation, seeded.data, emitted);

  const session = await openSession(change, changeDir, { cols: 80, rows: 24 }, id);
  const snapshots: { data: string; offset: number }[] = [];
  session.attach(() => undefined, (frame) => snapshots.push(frame), () => undefined);
  await waitFor("the seeded screen", async () => snapshots.length > 0, 15_000);
  expect(snapshots[0]?.data).toContain("DEEP-AT-H");
  expect(snapshots[0]?.offset).toBe(emitted);
}, 30_000);

test("a stale session cannot attach after its screen was released", async () => {
  process.env.CORVI_SCREEN_IDLE_MS = "1500";
  try {
    const session = await openSession("SNAP-STALE", dir, { cols: 80, rows: 24 });
    await waitFor("the screen to be released", async () => hubStats().hubs === 0, 15_000);
    // The session object predates the release; attaching now must be refused rather than touch
    // the disposed screen.
    let exited = false;
    const snapshots: { data: string; offset: number }[] = [];
    session.attach(
      () => undefined,
      (frame) => snapshots.push(frame),
      () => {
        exited = true;
      },
    );
    await until(async () => exited, true, 5_000);
    expect(exited).toBe(true);
    expect(snapshots).toHaveLength(0);
  } finally {
    delete process.env.CORVI_SCREEN_IDLE_MS;
  }
}, 30_000);

test("a window with no page captures its startup within the grace, before the ring evicts it", async () => {
  const change = "SNAP-NOPAGE";
  const changeDir = join(process.env.CORVI_ROOT ?? dir, change);
  await mkdir(changeDir, { recursive: true });
  // A window opened with no page: it draws a base, waits for the screen to attach, then emits far
  // more than the host ring holds. Only the screen created when the window opened can keep the
  // base once the ring has evicted it.
  const id = await newWindowRunningAsync(
    change,
    changeDir,
    "printf 'NO-PAGE-BASE-MARK\\n'; sleep 0.5; head -c 320000 /dev/zero | tr '\\0' X; echo NO-PAGE-TAIL",
    { keepOpen: true, announce: { label: "NoPage", notify: true } },
  );
  await waitFor(
    "the command to finish",
    async () => (await (await hostClient()).list()).some((entry) => entry.id === id && !entry.alive),
    15_000,
  );
  const session = await openSession(change, changeDir, { cols: 80, rows: 24 }, id);
  const ws = fakeSocket(session);
  terminalSockets.open(ws);
  await waitFor("the screen", async () => control(ws.frames).some((frame) => frame.type === "snapshot"), 15_000);
  const screen = String(control(ws.frames)[0]?.data ?? "");
  expect(screen).toContain("NO-PAGE-BASE-MARK"); // the startup draw, which the ring no longer holds
  expect(screen).toContain("NO-PAGE-TAIL"); // and the recent output
}, 30_000);

test("an over-cap screen serializes to a truncated screen, never the empty sentinel", async () => {
  const screen = makeScreen({ cols: 500, rows: 50 });
  // 2.5 MB on a 500-column grid: 5,000 rows of X's, past the 1 MiB cap.
  const chunk = "X".repeat(5000);
  let seq = 0;
  for (let i = 0; i < 500; i++) {
    screen.write(bytes(chunk), seq);
    seq += chunk.length;
  }
  await screen.whenApplied(seq);
  const snapshot = screen.serialize();
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.data).not.toBe(""); // never the empty sentinel the page reads as `reset`
  expect(snapshot.offset).toBe(seq);
  screen.dispose();
});

test("an over-cap screen does not blank the page and does not drop the stored screen", async () => {
  const session = await openSession("SNAP-OVER", dir, { cols: 500, rows: 50 });
  const command = "echo OVERCAP-BASE\n";
  await runAndWait(session, command);
  flushScreens();
  expect(snapshotOf(session.sessionId, session.incarnation)?.data).toContain("OVERCAP-BASE");

  // Overfill past the cap, then flush: the store must keep a screen (the trimmed one, or the
  // previous entry), and the page must get a non-empty snapshot rather than a blank `reset`.
  session.write("head -c 2500000 /dev/zero | tr '\\0' X; echo OVERCAP-END\n");
  await waitFor(
    "the fill",
    async () => ((await (await hostClient()).list()).find((entry) => entry.id === session.sessionId)?.lastSeq ?? 0) > 2000000,
    30_000,
  );
  await Bun.sleep(500);
  flushScreens();
  expect(snapshotOf(session.sessionId, session.incarnation)).toBeDefined();

  const snapshots: { data: string; offset: number }[] = [];
  session.attach(
    () => undefined,
    (frame) => snapshots.push(frame),
    () => undefined,
  );
  await waitFor("the page snapshot", async () => snapshots.length > 0, 15_000);
  expect(snapshots[0]?.data).not.toBe("");
}, 60_000);

test("a kept-open window's snapshot store entry survives its dead session; a plain dead one is pruned", () => {
  const record = (id: string, keepOpen: boolean): WindowRecord => ({
    id,
    kind: "host",
    panes: [id],
    activePane: id,
    active: false,
    activity: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(keepOpen ? { keepOpen } : {}),
  });
  const session = (id: string, incarnation: number, alive: boolean): SessionInfo =>
    ({ id, incarnation, alive, exitCode: alive ? undefined : 0 }) as unknown as SessionInfo;
  const kept = keptOpenPanes([[record("kept", true), record("plain", false)]]);
  expect(kept.has("kept")).toBe(true);
  expect(kept.has("plain")).toBe(false);
  // `kept` is dead but retained; `plain` is dead and dropped; `live` is alive and kept.
  const keys = liveSnapshotKeys([session("kept", 1, false), session("plain", 1, false), session("live", 2, true)], kept);
  expect(keys).toEqual(new Set(["kept#1", "live#2"]));
});

test("the snapshot store is keyed by incarnation and refuses oversized data", () => {
  setSnapshot("S", 1, "screen", 42);
  expect(snapshotOf("S", 1)).toMatchObject({ data: "screen", highWater: 42 });
  // A reused id with a new incarnation does not inherit the old snapshot.
  expect(snapshotOf("S", 2)).toBeUndefined();
  setSnapshot("S", 2, "second", 7);
  expect(snapshotOf("S", 1)?.data).toBe("screen");
  expect(snapshotOf("S", 2)?.data).toBe("second");

  const before = snapshotStats().snapshots;
  setSnapshot("BIG", 1, "x".repeat(SNAPSHOT_MAX_BYTES + 1), 1);
  expect(snapshotOf("BIG", 1)).toBeUndefined();
  setSnapshot("EMPTY", 1, "", 1);
  expect(snapshotOf("EMPTY", 1)).toBeUndefined();
  expect(snapshotStats().snapshots).toBe(before);
});

test("setSnapshot persists to the state dir, and load prunes to the live keys", () => {
  setSnapshot("DISK", 1, "on-disk", 5);
  const file = join(stateDir(), "terminal-snapshots.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: number; snapshots: Record<string, unknown> };
  expect(parsed.version).toBe(1);
  expect(parsed.snapshots["DISK#1"]).toMatchObject({ data: "on-disk", highWater: 5 });

  // A restart is a fresh read of the file. `afterEach` left the module unloaded, so this seeds a
  // file as an earlier server would have and lets the store read it, then prunes a dead key.
  clearSnapshots();
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      snapshots: {
        "BOOT#1": { data: "boot-screen", highWater: 9, savedAt: 1 },
        "DEAD#1": { data: "dead-screen", highWater: 3, savedAt: 2 },
      },
    }),
  );
  loadSnapshots();
  expect(snapshotOf("BOOT", 1)).toMatchObject({ data: "boot-screen", highWater: 9 });
  pruneSnapshots(new Set(["BOOT#1"]));
  expect(snapshotOf("DEAD", 1)).toBeUndefined();
  const after = JSON.parse(readFileSync(file, "utf8")) as { snapshots: Record<string, unknown> };
  expect(Object.keys(after.snapshots)).toEqual(["BOOT#1"]);
});

test("a store write that fails is reported and returns false, never throws", () => {
  // `stateDir()` is `<XDG_STATE_HOME>/corvi`; a regular file there makes the store's mkdir/write
  // fail. The cadence calls `setSnapshots` from a timer, so the failure must not escape it.
  const bad = join(dir, "not-a-directory");
  writeFileSync(bad, "a file, not a directory", "utf8");
  const saved = process.env.XDG_STATE_HOME;
  const savedLog = process.env.CORVI_LOG;
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  let stored: boolean | undefined;
  try {
    // The store prefers the app log when `CORVI_LOG` is set (a Corvi pane exports it); force the
    // stderr path this test asserts on.
    delete process.env.CORVI_LOG;
    process.env.XDG_STATE_HOME = bad;
    stored = setSnapshot("STORE-FAIL", 1, "screen", 5);
  } finally {
    console.error = original;
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    if (savedLog !== undefined) process.env.CORVI_LOG = savedLog;
  }
  expect(stored).toBe(false);
  expect(errors.some((line) => line.includes("could not write the snapshot store"))).toBe(true);
  clearSnapshots(); // the failed write's in-memory entry goes with the rest
}, 30_000);

test("a store write that fails is appended to CORVI_LOG when one is set", () => {
  const bad = join(dir, "not-a-directory-log");
  const log = join(dir, "store-failure.log");
  writeFileSync(bad, "a file, not a directory", "utf8");
  const savedState = process.env.XDG_STATE_HOME;
  const savedLog = process.env.CORVI_LOG;
  let stored: boolean | undefined;
  try {
    process.env.CORVI_LOG = log;
    process.env.XDG_STATE_HOME = bad;
    stored = setSnapshot("STORE-LOG", 1, "screen", 5);
  } finally {
    if (savedState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedState;
    if (savedLog === undefined) delete process.env.CORVI_LOG;
    else process.env.CORVI_LOG = savedLog;
  }
  expect(stored).toBe(false);
  expect(readFileSync(log, "utf8")).toContain("could not write the snapshot store");
  clearSnapshots();
}, 30_000);
