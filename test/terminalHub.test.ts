import { afterAll, afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { hostClient, closeHostClient } from "../apps/server/src/terminals/server/host.ts";
import { closeAttachments, hubStats, openSession } from "../apps/server/src/terminals/server/session.ts";
import { testTempDir, waitFor } from "./helpers.ts";

/**
 * The WebSocket hub, against a real host session. The host must run on Node, so the server's host
 * client is pointed at `node`; the host is shut down when the file ends.
 *
 * These pin the properties the flagship case depends on: one host attach per session even with
 * two sockets, output produced before a socket attaches is still delivered (from the host's
 * replay), fan-out, detach-never-kill, and no listener leak across attach/detach cycles.
 */
process.env.CORVI_HOST_RUNTIME = "node";
const dir = await testTempDir("hub");
// A tmux socket of this file's own: the window list reads tmux, and it must never reach the
// user's server.
delete process.env.TMUX;
process.env.CORVI_TMUX_SOCKET = join(dir, "tmux.sock");

type Collector = { readonly chunks: string[]; readonly send: (chunk: string) => void; readonly onExit: () => void };
const collector = (): Collector => {
  const chunks: string[] = [];
  return { chunks, send: (chunk) => chunks.push(chunk), onExit: () => undefined };
};
const saw = (collector: Collector, text: string): boolean => collector.chunks.join("").includes(text);

afterEach(() => {
  closeAttachments();
});

afterAll(async () => {
  await closeHostClient();
  await rm(dir, { recursive: true, force: true });
});

test("one host attach, output before any socket, and fan-out", async () => {
  const session = await openSession("HUB-1", dir, { cols: 80, rows: 24 });
  // Produced before any socket attaches: the host buffers it and replays on attach.
  session.write("echo PRE_$(( 0 + 1 ))_MARK\n");
  const first = collector();
  session.attach(first.send, first.onExit);
  await waitFor("the pre-attach output", async () => saw(first, "PRE_1_MARK"), 15_000);
  expect(hubStats().attached).toBe(1);

  const second = collector();
  session.attach(second.send, second.onExit);
  expect(hubStats().attached).toBe(1); // still one host attach for two sockets
  session.write("echo BOTH_$(( 0 + 1 ))_MARK\n");
  await waitFor("both sockets to see the new output", async () => saw(first, "BOTH_1_MARK") && saw(second, "BOTH_1_MARK"), 15_000);
  expect(hubStats().subscribers).toBe(2);
}, 30_000);

test("detaching never kills the shell, and re-attaching resumes", async () => {
  const session = await openSession("HUB-2", dir, { cols: 80, rows: 24 });
  const first = collector();
  session.attach(first.send, first.onExit);
  session.write("echo ALIVE_$(( 0 + 1 ))_MARK\n");
  await waitFor("the first output", async () => saw(first, "ALIVE_1_MARK"), 15_000);

  session.kill(); // detach, not kill
  expect(hubStats().attached).toBe(0);
  const live = (await (await hostClient()).list()).filter((entry) => entry.metadata?.change === "HUB-2" && entry.alive);
  expect(live).toHaveLength(1);

  const second = collector();
  session.attach(second.send, second.onExit);
  session.write("echo AGAIN_$(( 0 + 1 ))_MARK\n");
  await waitFor("the shell to answer after re-attach", async () => saw(second, "AGAIN_1_MARK"), 15_000);
}, 30_000);

test("attach/detach does not leak host listeners", async () => {
  const session = await openSession("HUB-3", dir, { cols: 80, rows: 24 });
  for (let cycle = 0; cycle < 3; cycle++) {
    const seen = collector();
    session.attach(seen.send, seen.onExit);
    session.write(`echo CYCLE_${cycle}_$(( 0 + 1 ))_MARK\n`);
    await waitFor(`cycle ${cycle} output`, async () => saw(seen, `CYCLE_${cycle}_1_MARK`), 15_000);
    session.kill();
    expect(hubStats().attached).toBe(0);
  }
  // If an old listener had leaked, the last word would be delivered twice.
  const last = collector();
  session.attach(last.send, last.onExit);
  session.write("echo LEAK_$(( 0 + 1 ))_PROBE\n");
  await waitFor("the probe", async () => saw(last, "LEAK_1_PROBE"), 15_000);
  await Bun.sleep(200);
  const occurrences = last.chunks.join("").split("LEAK_1_PROBE").length - 1;
  expect(occurrences).toBe(1);
}, 30_000);
