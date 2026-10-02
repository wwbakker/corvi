import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { hostClient, closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { closeAttachments, hubStats, openSession } from "../apps/server/src/terminals/server/session.ts";
import { testTempDir, until, waitFor } from "./helpers.ts";

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
};
const restoreEnv = (): void => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
process.env.CORVI_HOST_RUNTIME = "node";
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

/** Wait for the host to have emitted at least one byte for the session, so a write is on its way
 * to the hub before a test attaches. */
const waitEmitted = async (sessionId: string): Promise<void> =>
  waitFor(
    "the host to emit",
    async () => ((await (await hostClient()).list()).find((entry) => entry.id === sessionId)?.lastSeq ?? 0) > 0,
    15_000,
  );

afterEach(() => {
  closeAttachments();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
});

test("the screen is fed with no page attached, and a second attach is refused", async () => {
  const session = await openSession("HUB-1", dir, { cols: 80, rows: 24 });
  const before = collector();
  session.attach(before.send, before.snapshot, before.onExit);
  // Prove the attach works at all, then detach so the next output is produced with no page.
  await waitFor("the first attach", async () => before.snapshots.length > 0, 25_000);
  before.onExit = () => undefined;
  session.kill();

  // Produced with no page attached: the screen is still fed it, so a later attach's snapshot
  // carries it without any byte replay.
  session.write("echo PRE_$(( 0 + 1 ))_MARK\n");
  await waitEmitted(session.sessionId);
  await Bun.sleep(300);

  const first = collector();
  session.attach(first.send, first.snapshot, first.onExit);
  await waitFor("the snapshot", async () => first.snapshots.length > 0, 25_000);
  expect(screenOf(first)).toContain("PRE_1_MARK");
  expect(hubStats().attached).toBe(1);
  expect(hubStats().subscribers).toBe(1);

  // One live client per hub: a second attach is refused rather than fanned out into a stream it
  // got no snapshot for.
  const second = collector();
  session.attach(second.send, second.snapshot, second.onExit);
  expect(hubStats().subscribers).toBe(1);
  session.write("echo ONE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the one subscriber to see the output", async () => saw(first, "ONE_1_MARK"), 25_000);
  await Bun.sleep(200);
  expect(saw(second, "ONE_1_MARK")).toBe(false);
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
  session.write("echo AGAIN_$(( 0 + 1 ))_MARK\n");
  await waitEmitted(session.sessionId);
  await Bun.sleep(300);
  const second = collector();
  session.attach(second.send, second.snapshot, second.onExit);
  await waitFor("the resumed screen", async () => screenOf(second).includes("AGAIN_1_MARK"), 25_000);
  expect(screenOf(second)).toContain("ALIVE_1_MARK");
}, 60_000);

test("a second openSession for one session is refused at the hub, not fanned out", async () => {
  const first = await openSession("HUB-4", dir, { cols: 80, rows: 24 });
  first.write("echo FIRST_$(( 0 + 1 ))_MARK\n");
  const one = collector();
  first.attach(one.send, one.snapshot, one.onExit);
  await waitFor("the first output", async () => saw(one, "FIRST_1_MARK"), 25_000);

  // A second session object over the same host session and incarnation. The per-object guard in
  // `openSession` cannot see it; the hub must, or the second page would silently get a second
  // stream. It answers with the exit instead.
  const second = await openSession("HUB-4", dir, { cols: 80, rows: 24 });
  let exited = false;
  const two = collector();
  two.onExit = () => {
    exited = true;
  };
  second.attach(two.send, two.snapshot, two.onExit);
  await until(async () => exited, true, 10_000);
  expect(exited).toBe(true);
  expect(hubStats().subscribers).toBe(1);

  first.write("echo MORE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the first client to keep receiving", async () => saw(one, "MORE_1_MARK"), 25_000);
  await Bun.sleep(200);
  expect(saw(two, "MORE_1_MARK")).toBe(false);
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
