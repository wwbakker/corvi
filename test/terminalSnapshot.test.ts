import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { hostClient, closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { closeAttachments, openSession, terminalSockets } from "../apps/server/src/terminals/server/session.ts";
import {
  SNAPSHOT_MAX_BYTES,
  SCROLLBACK_DEFAULT,
  SCROLLBACK_MAX,
  absoluteCursor,
  byteLength,
  serializeTerminal,
} from "../apps/web/src/terminals/client/snapshot.ts";
import {
  clearSnapshots,
  setSnapshot,
  snapshotOf,
  snapshotStats,
} from "../apps/server/src/terminals/server/snapshots.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * Renderer-owned snapshots: the page serializes its xterm, the server stores the latest per
 * `(sessionId, incarnation)` and replays it on connect, and a truncated replay resets instead of
 * drawing over corrupt state. The protocol half runs against a real host session through fake
 * sockets; the serialization half runs against a real headless xterm.
 */
process.env.CORVI_HOST_RUNTIME = "node";
const dir = await testTempDir("snapshot");
delete process.env.TMUX;
process.env.CORVI_TMUX_SOCKET = join(dir, "tmux.sock");

type FakeSocket = {
  readonly data: { readonly session: Awaited<ReturnType<typeof openSession>> };
  readonly frames: (string | Uint8Array)[];
  readonly send: (chunk: string | Uint8Array) => void;
  readonly close: () => void;
};
const fakeSocket = (session: Awaited<ReturnType<typeof openSession>>): FakeSocket => {
  const frames: (string | Uint8Array)[] = [];
  return { data: { session }, frames, send: (chunk) => frames.push(chunk), close: () => undefined };
};

const text = (frames: (string | Uint8Array)[]): string =>
  frames
    .filter((frame): frame is Uint8Array => typeof frame !== "string")
    .map((frame) => Buffer.from(frame).toString("utf8"))
    .join("");
const receivedBytes = (frames: (string | Uint8Array)[]): number =>
  frames.reduce((sum, frame) => sum + (typeof frame === "string" ? 0 : frame.length), 0);
const control = (frames: (string | Uint8Array)[]): Record<string, unknown>[] =>
  frames.filter((frame): frame is string => typeof frame === "string").map((frame) => JSON.parse(frame) as Record<string, unknown>);

afterEach(() => {
  closeAttachments();
  clearSnapshots();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
});

test("the snapshot cap drops the oldest rows and keeps the recent screen", () => {
  // The defaults the terminal is built with.
  expect(SCROLLBACK_DEFAULT).toBe(5000);
  expect(SCROLLBACK_MAX).toBe(50000);
  expect(SNAPSHOT_MAX_BYTES).toBe(1024 * 1024);

  // A serializer whose output grows with the rows it is asked for: the cap has to shrink the
  // scrollback until it fits. The real addon is exercised by the browser round trip
  // (test/terminal.test.ts), which is what proves the page's own serialization.
  const serializer = {
    serialize: (options?: { scrollback?: number }): string => "x".repeat((options?.scrollback ?? 0) + 20),
  };
  const term = { buffer: { active: { cursorX: 4, cursorY: 2 } }, options: { scrollback: 1000 } };
  const capped = serializeTerminal(term, serializer, 200);
  expect(byteLength(capped)).toBeLessThanOrEqual(200);
  // The absolute cursor correction is the last thing in the snapshot.
  expect(capped.endsWith(absoluteCursor(term))).toBe(true);
});

test("the snapshot store is keyed by incarnation and refuses oversized data", () => {
  setSnapshot("S", 1, "screen", 42);
  expect(snapshotOf("S", 1)).toEqual({ data: "screen", highWater: 42 });
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

test("the server replays a stored snapshot, then resumes from its high-water offset", async () => {
  const first = fakeSocket(await openSession("SNAP-RESUME", dir, { cols: 80, rows: 24 }));
  terminalSockets.open(first);
  // No snapshot yet: a fresh reset.
  expect(control(first.frames)).toEqual([{ type: "reset", since: 0, incarnation: first.data.session.incarnation }]);

  terminalSockets.message(first, JSON.stringify({ type: "attach", since: 0 }));
  first.data.session.write("echo FIRST_$(( 0 + 1 ))_MARK\n");
  await waitFor("the first marker", async () => text(first.frames).includes("FIRST_1_MARK"), 15_000);

  // The page snapshots what it has applied; the server stores it.
  const highWater = receivedBytes(first.frames);
  terminalSockets.message(first, JSON.stringify({ type: "snapshot", data: "SNAP-DATA", highWater }));
  expect(snapshotOf(first.data.session.sessionId, first.data.session.incarnation)).toEqual({ data: "SNAP-DATA", highWater });

  // Detach (the page closes), and produce output while nobody is attached.
  terminalSockets.close(first);
  first.data.session.write("echo SECOND_$(( 0 + 1 ))_MARK\n");
  await Bun.sleep(300);

  // A new connection gets the snapshot first, then attaches from its offset.
  const second = fakeSocket(await openSession("SNAP-RESUME", dir, { cols: 80, rows: 24 }));
  terminalSockets.open(second);
  const opening = control(second.frames);
  expect(opening).toHaveLength(1);
  expect(opening[0]).toMatchObject({ type: "snapshot", data: "SNAP-DATA", highWater });
  terminalSockets.message(second, JSON.stringify({ type: "attach", since: highWater }));
  await waitFor("the resumed marker", async () => text(second.frames).includes("SECOND_1_MARK"), 15_000);
  // Resumed, not replayed: the bytes before the snapshot are not drawn again.
  expect(text(second.frames)).not.toContain("FIRST_1_MARK");
  expect(second.frames.some((frame) => typeof frame === "string" && (JSON.parse(frame) as { type?: string }).type === "truncated")).toBe(false);
}, 30_000);

test("a truncated replay resets the page before the host's oldest byte", async () => {
  const first = fakeSocket(await openSession("SNAP-TRUNC", dir, { cols: 80, rows: 24 }));
  terminalSockets.open(first);
  terminalSockets.message(first, JSON.stringify({ type: "attach", since: 0 }));
  first.data.session.write("echo WARM_$(( 0 + 1 ))_MARK\n");
  await waitFor("the warm marker", async () => text(first.frames).includes("WARM_1_MARK"), 15_000);
  terminalSockets.close(first);

  // Overflow the host's 256 KB ring while nobody is attached.
  first.data.session.write("head -c 400000 /dev/zero | tr '\\0' 'x'\n");
  await Bun.sleep(1500);

  const second = fakeSocket(await openSession("SNAP-TRUNC", dir, { cols: 80, rows: 24 }));
  terminalSockets.open(second);
  terminalSockets.message(second, JSON.stringify({ type: "attach", since: 0 }));
  await waitFor(
    "the truncated control frame",
    async () => second.frames.some((frame) => typeof frame === "string" && (JSON.parse(frame) as { type?: string }).type === "truncated"),
    15_000,
  );
  // The reset comes before the host's bytes: the first frame after the reset is the replay.
  const frames = second.frames;
  const resetAt = frames.findIndex((frame) => typeof frame === "string" && (JSON.parse(frame) as { type?: string }).type === "truncated");
  const firstBinaryAt = frames.findIndex((frame) => typeof frame !== "string");
  expect(resetAt).toBeGreaterThanOrEqual(0);
  expect(firstBinaryAt).toBeGreaterThan(resetAt);
  const since = (JSON.parse(frames[resetAt] as string) as { since: number }).since;
  expect(since).toBeGreaterThan(0);
}, 30_000);
