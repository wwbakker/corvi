import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { hostClient, closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { closeAttachments, hubStats, openSession } from "../apps/server/src/terminals/server/session.ts";
import { testTempDir, until, waitFor } from "./helpers.ts";

/**
 * The WebSocket hub, against a real host session. The host must run on Node, so the server's host
 * client is pointed at `node`; the host is shut down when the file ends.
 *
 * These pin the properties the flagship case depends on: one host attach per session even with
 * two sockets, output produced before a socket attaches is still delivered (from the host's
 * replay), fan-out, detach-never-kill, and no listener leak across attach/detach cycles.
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

type Collector = {
  readonly chunks: Uint8Array[];
  readonly resets: number[];
  readonly send: (chunk: Uint8Array) => void;
  readonly reset: (since: number) => void;
  onExit: () => void;
};
const collector = (): Collector => {
  const chunks: Uint8Array[] = [];
  const resets: number[] = [];
  return {
    chunks,
    resets,
    send: (chunk) => chunks.push(chunk),
    reset: (since) => resets.push(since),
    onExit: () => undefined,
  };
};
const saw = (collector: Collector, text: string): boolean =>
  Buffer.concat(collector.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8").includes(text);

afterEach(() => {
  closeAttachments();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
  restoreEnv();
});

test("one host attach, output before any socket, and a refused second attach", async () => {
  const session = await openSession("HUB-1", dir, { cols: 80, rows: 24 });
  // Produced before any socket attaches: the host buffers it and replays on attach.
  session.write("echo PRE_$(( 0 + 1 ))_MARK\n");
  const first = collector();
  session.attach(first.send, first.reset, first.onExit, 0);
  await waitFor("the pre-attach output", async () => saw(first, "PRE_1_MARK"), 25_000);
  expect(hubStats().attached).toBe(1);
  expect(hubStats().subscribers).toBe(1);

  // One live client per session: a second attach on the same socket is refused rather than
  // silently fanning out. A late subscriber would miss the gap between its snapshot and the
  // already-forwarded bytes — the one-live-client boundary (see the session module's comment).
  const second = collector();
  session.attach(second.send, second.reset, second.onExit, 0);
  expect(hubStats().subscribers).toBe(1);
  session.write("echo ONE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the one subscriber to see the output", async () => saw(first, "ONE_1_MARK"), 25_000);
  await Bun.sleep(200);
  expect(saw(second, "ONE_1_MARK")).toBe(false);
}, 60_000);

test("detaching never kills the shell, and re-attaching resumes", async () => {
  const session = await openSession("HUB-2", dir, { cols: 80, rows: 24 });
  const first = collector();
  session.attach(first.send, first.reset, first.onExit, 0);
  session.write("echo ALIVE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the first output", async () => saw(first, "ALIVE_1_MARK"), 25_000);

  session.kill(); // detach, not kill
  expect(hubStats().attached).toBe(0);
  const live = (await (await hostClient()).list()).filter((entry) => entry.metadata?.change === "HUB-2" && entry.alive);
  expect(live).toHaveLength(1);

  const second = collector();
  session.attach(second.send, second.reset, second.onExit, 0);
  session.write("echo AGAIN_$(( 0 + 1 ))_MARK\n");
  await waitFor("the shell to answer after re-attach", async () => saw(second, "AGAIN_1_MARK"), 25_000);
}, 60_000);

test("a second openSession for one session is refused at the hub, not fanned out", async () => {
  const first = await openSession("HUB-4", dir, { cols: 80, rows: 24 });
  first.write("echo FIRST_$(( 0 + 1 ))_MARK\n");
  const one = collector();
  first.attach(one.send, one.reset, one.onExit, 0);
  await waitFor("the first output", async () => saw(one, "FIRST_1_MARK"), 25_000);

  // A second session object over the same host session and incarnation. The per-object guard in
  // `openSession` cannot see it; the hub must, or the second page would silently get future bytes
  // only. It answers with the exit instead.
  const second = await openSession("HUB-4", dir, { cols: 80, rows: 24 });
  let exited = false;
  const two = collector();
  two.onExit = () => {
    exited = true;
  };
  second.attach(two.send, two.reset, two.onExit, 0);
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
    session.attach(seen.send, seen.reset, seen.onExit, 0);
    session.write(`echo CYCLE_${cycle}_$(( 0 + 1 ))_MARK\n`);
    await waitFor(`cycle ${cycle} output`, async () => saw(seen, `CYCLE_${cycle}_1_MARK`), 25_000);
    session.kill();
    expect(hubStats().attached).toBe(0);
  }
  // If an old listener had leaked, the last word would be delivered twice.
  const last = collector();
  session.attach(last.send, last.reset, last.onExit, 0);
  session.write("echo LEAK_$(( 0 + 1 ))_PROBE\n");
  await waitFor("the probe", async () => saw(last, "LEAK_1_PROBE"), 25_000);
  await Bun.sleep(200);
  const occurrences = last.chunks
    .map((chunk) => Buffer.from(chunk).toString("utf8"))
    .join("")
    .split("LEAK_1_PROBE").length - 1;
  expect(occurrences).toBe(1);
}, 60_000);
