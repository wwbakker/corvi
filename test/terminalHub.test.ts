import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { hostClient, closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { closeAttachments, hubStats, openSession } from "../apps/server/src/terminals/server/session.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * The WebSocket hub and its server-owned screen, against a real host session. The host must run
 * on Node, so the server's host client is pointed at `node`; the host is shut down when the file
 * ends.
 *
 * These pin the properties the pivot depends on: the screen is fed while no page is attached, a
 * page gets the snapshot and then every byte after it, detach-never-kill keeps the screen,
 * one-live-client, and no host-listener leak.
 */
// The env this file mutates, saved so a co-located test file does not inherit it (bun runs the
// files of a run in one process).
const savedEnv = {
  CORVI_HOST_RUNTIME: process.env.CORVI_HOST_RUNTIME,
  CORVI_SCREEN_IDLE_MS: process.env.CORVI_SCREEN_IDLE_MS,
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
// These tests reuse one `TerminalSession` across a detach and re-attach, which production does not
// (a returning page opens a new socket, and `openSession` recreates a released screen). Hold the
// screen long enough that the reuse stays valid and the test measures the hub, not the grace.
process.env.CORVI_SCREEN_IDLE_MS = "120000";
const dir = await testTempDir("hub");

type SnapshotFrame = { readonly data: string; readonly offset: number };
type Collector = {
  readonly chunks: Uint8Array[];
  readonly snapshots: SnapshotFrame[];
  readonly send: (chunk: Uint8Array) => void;
  readonly snapshot: (frame: SnapshotFrame) => void;
  onExit: () => void;
};
const collector = (): Collector => {
  const chunks: Uint8Array[] = [];
  const snapshots: SnapshotFrame[] = [];
  return {
    chunks,
    snapshots,
    send: (chunk) => chunks.push(chunk),
    snapshot: (frame) => snapshots.push(frame),
    onExit: () => undefined,
  };
};
/** The live bytes a collector has received, as text. */
const live = (collector: Collector): string =>
  Buffer.concat(collector.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
const saw = (collector: Collector, text: string): boolean => live(collector).includes(text);
/** The screen as the last snapshot handed to a collector. */
const screenOf = (collector: Collector): string =>
  collector.snapshots.map((frame) => frame.data).join("");

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

afterEach(() => {
  closeAttachments();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
});

test("the screen is fed with no page attached", async () => {
  const session = await openSession("HUB-1", dir, { cols: 80, rows: 24 });
  const before = collector();
  session.attach(before.send, before.snapshot, before.onExit);
  // Prove the attach works at all, then detach so the next output is produced with no page.
  await waitFor("the first attach", async () => before.snapshots.length > 0, 25_000);
  before.onExit = () => undefined;
  session.kill();

  // Produced with no page attached: the screen is still fed it, so a later attach's snapshot
  // carries it without any byte replay.
  const command = "echo PRE_$(( 0 + 1 ))_MARK\n";
  await runAndWait(session, command);

  let firstExited = false;
  const first = collector();
  first.onExit = () => {
    firstExited = true;
  };
  session.attach(first.send, first.snapshot, first.onExit);
  await waitFor("the snapshot", async () => first.snapshots.length > 0, 25_000);
  // The screen was fed with no page, so the output is in the snapshot; if the host's last bytes
  // were still in flight to the server when the attach serialized, they arrive as the immediate
  // live bytes, which is the same screen. Result way the page sees it without a replay.
  await waitFor("the mark on the screen", async () => (screenOf(first) + live(first)).includes("PRE_1_MARK"), 15_000);
  expect(screenOf(first) + live(first)).toContain("PRE_1_MARK");
  expect(hubStats().attached).toBe(1);
  expect(hubStats().subscribers).toBe(1);

  // A reattach is a new socket (a new `openSession`), not a second `attach` on the same object.
  // The previous page's socket is still closing, so its subscriber is still in the hub: the
  // reattach supersedes it and is served the screen, rather than being answered with `exit`.
  const reattached = await openSession("HUB-1", dir, { cols: 80, rows: 24 });
  const second = collector();
  reattached.attach(second.send, second.snapshot, second.onExit);
  expect(firstExited).toBe(true);
  await waitFor("the second snapshot", async () => second.snapshots.length > 0, 25_000);
  expect(screenOf(second)).toContain("PRE_1_MARK");
  expect(hubStats().subscribers).toBe(1);
  reattached.write("echo ONE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the new subscriber to see the output", async () => saw(second, "ONE_1_MARK"), 25_000);
  await Bun.sleep(200);
  expect(saw(first, "ONE_1_MARK")).toBe(false);
}, 60_000);

test("detaching never kills the shell or the screen, and re-attaching resumes from it", async () => {
  const session = await openSession("HUB-2", dir, { cols: 80, rows: 24 });
  const first = collector();
  session.attach(first.send, first.snapshot, first.onExit);
  session.write("echo ALIVE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the first output", async () => saw(first, "ALIVE_1_MARK"), 25_000);

  session.kill(); // detach, not kill
  // The screen belongs to the session: the host listener stays while it exists.
  expect(hubStats().attached).toBe(1);
  const alive = (await (await hostClient()).list()).filter((entry) => entry.metadata?.change === "HUB-2" && entry.alive);
  expect(alive).toHaveLength(1);

  // Produced while detached, then served to the new page from the screen.
  const command = "echo AGAIN_$(( 0 + 1 ))_MARK\n";
  await runAndWait(session, command);
  const second = collector();
  session.attach(second.send, second.snapshot, second.onExit);
  await waitFor("the resumed screen", async () => screenOf(second).includes("AGAIN_1_MARK"), 25_000);
  expect(screenOf(second)).toContain("ALIVE_1_MARK");
}, 60_000);

test("a second openSession over one session supersedes the first page, not fans out", async () => {
  const first = await openSession("HUB-4", dir, { cols: 80, rows: 24 });
  first.write("echo FIRST_$(( 0 + 1 ))_MARK\n");
  let firstExited = false;
  const one = collector();
  one.onExit = () => {
    firstExited = true;
  };
  first.attach(one.send, one.snapshot, one.onExit);
  await waitFor("the first output", async () => saw(one, "FIRST_1_MARK"), 25_000);

  // A second session object over the same host session and incarnation. The per-object guard in
  // `openSession` cannot see it; the hub supersedes the old page, so the reattach is served the
  // screen and the old page is told the session is gone instead of both receiving the stream.
  const second = await openSession("HUB-4", dir, { cols: 80, rows: 24 });
  const two = collector();
  second.attach(two.send, two.snapshot, two.onExit);
  expect(firstExited).toBe(true);
  await waitFor("the second snapshot", async () => screenOf(two).includes("FIRST_1_MARK"), 25_000);
  expect(hubStats().subscribers).toBe(1);

  first.write("echo MORE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the new client to keep receiving", async () => saw(two, "MORE_1_MARK"), 25_000);
  await Bun.sleep(200);
  expect(saw(one, "MORE_1_MARK")).toBe(false);
}, 60_000);

test("two concurrent attaches: the newcomer is queued, and the screen keeps every byte", async () => {
  const a = await openSession("HUB-5", dir, { cols: 80, rows: 24 });
  const b = await openSession("HUB-5", dir, { cols: 80, rows: 24 });
  // A stream whose tail races the attach's serialize window.
  a.write("seq 1 300 | sed 's/^/RACE-/'; echo RACE-DONE\n");
  const one = collector();
  const two = collector();
  // Both attaches in one tick. The hub serves the first and queues the second (newest wins), which
  // then supersedes it: a newcomer is never refused with a final `exit`, and the first's held bytes
  // are still fed to the screen.
  a.attach(one.send, one.snapshot, one.onExit);
  b.attach(two.send, two.snapshot, two.onExit);
  await waitFor("the second snapshot", async () => two.snapshots.length > 0, 25_000);
  expect(hubStats().subscribers).toBe(1);
  await waitFor("the stream to drain", async () => (screenOf(two) + live(two)).includes("RACE-DONE"), 25_000);

  // No byte was orphaned: the screen applied every byte the host had emitted. Let the shell's
  // prompt settle, then measure the host's last offset. The probe's snapshot reports the offset it
  // serialized, which must be at least that — a byte left behind the attach would be lost.
  await Bun.sleep(300);
  const total = (await (await hostClient()).list()).find((entry) => entry.id === a.sessionId)?.lastSeq ?? 0;
  a.kill();
  const c = await openSession("HUB-5", dir, { cols: 80, rows: 24 });
  const probe = collector();
  c.attach(probe.send, probe.snapshot, probe.onExit);
  await waitFor("the probe snapshot", async () => probe.snapshots.length > 0, 15_000);
  expect(probe.snapshots[0]?.offset).toBeGreaterThanOrEqual(total);
  expect(screenOf(probe)).toContain("RACE-DONE");
}, 60_000);

test("attach/detach does not leak host listeners", async () => {
  const session = await openSession("HUB-3", dir, { cols: 80, rows: 24 });
  for (let cycle = 0; cycle < 3; cycle++) {
    const seen = collector();
    session.attach(seen.send, seen.snapshot, seen.onExit);
    session.write(`echo CYCLE_${cycle}_$(( 0 + 1 ))_MARK\n`);
    await waitFor(`cycle ${cycle} output`, async () => saw(seen, `CYCLE_${cycle}_1_MARK`), 25_000);
    session.kill();
    // The screen keeps the host listener; detaching must not double it.
    expect(hubStats().attached).toBe(1);
  }
  // If an old data listener had leaked, the last word would be delivered twice.
  const last = collector();
  session.attach(last.send, last.snapshot, last.onExit);
  session.write("echo LEAK_$(( 0 + 1 ))_PROBE\n");
  await waitFor("the probe", async () => saw(last, "LEAK_1_PROBE"), 25_000);
  await Bun.sleep(200);
  expect(live(last).split("LEAK_1_PROBE").length - 1).toBe(1);
}, 60_000);
