/**
 * Phase 3 measurement runner. Feeds one recorded pty stream into a real (`@xterm/headless`) core
 * and compares two ways of restoring screen state:
 *
 *   (a) renderer-owned: the client holds the terminal, snapshots it, and on reconnect replays the
 *       snapshot then the pty output from the snapshot's high-water byte offset (`attach since`);
 *   (b) server-owned: a long-lived server terminal holds the state and serializes it on connect.
 *
 * The snapshot is taken after the feature-rich part of the stream (SGR/wide/emoji/cursor/split
 * escape/alt-screen) and again while the alternate screen is active, and each restore is compared
 * to the pre-disconnect screen *before* the tail, then to the whole-stream reference after it.
 * Fidelity uses both `addon.serialize` and an independent per-cell attribute signature.
 *
 * Prints one `READY {json}` line with the checks, metrics and timings; `run.sh` asserts them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureHost } from "../terminal-host/client.ts";
import {
  acceptSnapshot,
  cellSignature,
  feedBytes,
  makeTerminal,
  newSerializeAddon,
  restore,
  rowsText,
  snapshot,
  type SerializeAddon,
  type SnapshotRecord,
  type XtermTerminal,
} from "./xterm.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const socket = argOf("--socket");
const checkout = argOf("--checkout") ?? process.cwd();
if (socket === undefined) {
  console.error("usage: run.ts --socket <path> [--checkout <path>]");
  process.exit(2);
}

const COLS = 120;
const ROWS = 40;
const SCROLLBACK = 5000;
const HOST_BUFFER = 256 * 1024;
const CAP = 1024 * 1024;
const stream = readFileSync(fileURLToPath(new URL("./stream.bin", import.meta.url)));

const checks: Record<string, boolean> = {};
const metrics: Record<string, number> = {};
const timings: Record<string, number> = {};
const notes: Record<string, string> = {};
const set = (name: string, value: boolean): void => {
  checks[name] = value;
};
const rssMb = (): number => Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
const addonOf = (term: XtermTerminal): SerializeAddon => {
  const addon = newSerializeAddon();
  term.loadAddon(addon);
  return addon;
};
const flush = (term: XtermTerminal): Promise<void> => new Promise((resolve) => term.write("", () => resolve()));
const write = async (term: XtermTerminal, data: string): Promise<void> => {
  term.write(data);
  await flush(term);
};

// Where the feature-rich section ends and where the alternate screen is live.
const afterTui = stream.indexOf("after tui 00000");
const altEnter = stream.indexOf("\x1b[?1049h");
const altActive = stream.indexOf("Tasks: 1 running");
const altExit = stream.indexOf("\x1b[?1049l");
set("stream.offsets", afterTui > altExit && altEnter >= 0 && altActive > altEnter && altExit > altActive);

// The reference screen: the whole stream, in small chunks so escapes and UTF-8 split.
const reference = makeTerminal(COLS, ROWS, SCROLLBACK);
const refAddon = addonOf(reference);
await feedBytes(reference, stream, 7);
metrics.referenceRows = reference.buffer.active.length;
metrics.streamBytes = stream.length;

/** Snapshot at `offset`, restore, compare immediately, then feed the tail and compare again. */
const verifyRestoreAt = async (name: string, offset: number): Promise<void> => {
  const pre = makeTerminal(COLS, ROWS, SCROLLBACK);
  const preAddon = addonOf(pre);
  await feedBytes(pre, stream.subarray(0, offset), 7);
  const snap = snapshot(pre, preAddon);
  if (name === "rendererAfterFeatures") {
    metrics.rendererSnapshotBytes = Buffer.byteLength(snap);
    metrics.rendererHighWater = offset;
  }

  const { term: restored, addon } = restore(snap, COLS, ROWS, SCROLLBACK);
  await write(restored, snap);
  const preBuffer = pre.buffer.active;
  const restoredBuffer = restored.buffer.active;
  set(`${name}.preCursor`, restoredBuffer.cursorX === preBuffer.cursorX && restoredBuffer.cursorY === preBuffer.cursorY);
  set(`${name}.preScroll`, restoredBuffer.baseY === preBuffer.baseY && restoredBuffer.viewportY === preBuffer.viewportY);
  set(`${name}.preBufferType`, restoredBuffer.type === preBuffer.type);
  const preRows = rowsText(pre);
  const restoredRows = rowsText(restored);
  set(`${name}.preRows`, preRows.length === restoredRows.length && preRows.every((row, at) => row === restoredRows[at]));
  set(`${name}.preCells`, cellSignature(pre) === cellSignature(restored));

  await feedBytes(restored, stream.subarray(offset), 7);
  const finalBuffer = restored.buffer.active;
  const refBuffer = reference.buffer.active;
  const refRows = rowsText(reference);
  const finalRows = rowsText(restored);
  set(`${name}.finalCursor`, finalBuffer.cursorX === refBuffer.cursorX && finalBuffer.cursorY === refBuffer.cursorY);
  set(`${name}.finalScroll`, finalBuffer.baseY === refBuffer.baseY && finalBuffer.viewportY === refBuffer.viewportY);
  set(`${name}.finalBufferType`, finalBuffer.type === refBuffer.type);
  set(`${name}.finalRows`, refRows.length === finalRows.length && finalRows.every((row, at) => row === refRows[at]));
  set(`${name}.finalCells`, cellSignature(restored) === cellSignature(reference));
  set(`${name}.finalSerialized`, snapshot(restored, addon) === snapshot(reference, refAddon));
};

await verifyRestoreAt("rendererAfterFeatures", afterTui);
await verifyRestoreAt("rendererAltActive", altActive);

// --- (b) server-owned, minimal -------------------------------------------------------------------
{
  const server = makeTerminal(COLS, ROWS, SCROLLBACK);
  const serverAddon = addonOf(server);
  await feedBytes(server, stream, 7);
  const connectStart = performance.now();
  const snap = snapshot(server, serverAddon);
  timings.serverSnapshotOnConnectMs = Number((performance.now() - connectStart).toFixed(2));
  metrics.serverSnapshotBytes = Buffer.byteLength(snap);
  const { term: clientTerm, addon: clientAddon } = restore(snap, COLS, ROWS, SCROLLBACK);
  await write(clientTerm, snap);
  const serverBuffer = server.buffer.active;
  const clientBuffer = clientTerm.buffer.active;
  set("server.cursor", clientBuffer.cursorX === serverBuffer.cursorX && clientBuffer.cursorY === serverBuffer.cursorY);
  set("server.scroll", clientBuffer.baseY === serverBuffer.baseY && clientBuffer.viewportY === serverBuffer.viewportY);
  set("server.bufferType", clientBuffer.type === serverBuffer.type);
  const serverRows = rowsText(server);
  const clientRows = rowsText(clientTerm);
  set("server.rows", serverRows.length === clientRows.length && clientRows.every((row, at) => row === serverRows[at]));
  set("server.cells", cellSignature(server) === cellSignature(clientTerm));
  set("server.serialized", snapshot(clientTerm, clientAddon) === snapshot(server, serverAddon));
  metrics.serverRows = server.buffer.active.length;
}

// --- cross-geometry: 120x40 snapshot restored into 80x24 -----------------------------------------
{
  const pre = makeTerminal(COLS, ROWS, SCROLLBACK);
  const preAddon = addonOf(pre);
  await feedBytes(pre, stream.subarray(0, afterTui), 7);
  const corrected = snapshot(pre, preAddon);
  const { term: withFix } = restore(corrected, 80, 24, SCROLLBACK);
  await write(withFix, corrected);
  const fixBuffer = withFix.buffer.active;
  set("crossGeometry.restores", withFix.buffer.active.length > 0);
  set("crossGeometry.cursorInBounds", fixBuffer.cursorX >= 0 && fixBuffer.cursorX < 80 && fixBuffer.cursorY >= 0 && fixBuffer.cursorY < 24);

  // The same serialization without the absolute-cursor move: does the correction change anything?
  const uncorrected = preAddon.serialize();
  const { term: withoutFix } = restore(uncorrected, 80, 24, SCROLLBACK);
  await write(withoutFix, uncorrected);
  const noFixBuffer = withoutFix.buffer.active;
  notes.crossGeometryCursorWithFix = `${fixBuffer.cursorX},${fixBuffer.cursorY}`;
  notes.crossGeometryCursorWithoutFix = `${noFixBuffer.cursorX},${noFixBuffer.cursorY}`;
  set(
    "crossGeometry.correctionChangesOutcome",
    fixBuffer.cursorX !== noFixBuffer.cursorX || fixBuffer.cursorY !== noFixBuffer.cursorY,
  );
}

// --- snapshot key: (id, incarnation) -------------------------------------------------------------
{
  const record: SnapshotRecord = { sessionId: "s", incarnation: 1, highWater: 100, data: "x" };
  set("incarnation.acceptsSame", acceptSnapshot(record, "s", 1));
  set("incarnation.rejectsKilled", !acceptSnapshot(record, "s", 2) && !acceptSnapshot(record, "other", 1));
}

// --- snapshot size/time and memory at 5k and 50k, and the 1 MiB cap ------------------------------
const fill = async (scrollback: number, targetRows: number): Promise<{ term: XtermTerminal; addon: SerializeAddon }> => {
  const term = makeTerminal(COLS, ROWS, scrollback);
  const addon = addonOf(term);
  let guard = 0;
  while (term.buffer.active.length < targetRows && guard < 12) {
    await feedBytes(term, stream, 8192);
    guard++;
  }
  return { term, addon };
};
{
  const measured = async (scrollback: number, target: number): Promise<{ bytes: number; rows: number; ms: number; rss: number }> => {
    const before = rssMb();
    const { term, addon } = await fill(scrollback, target);
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const snap = snapshot(term, addon);
      samples.push(performance.now() - start);
      bytes = Buffer.byteLength(snap);
    }
    samples.sort((a, b) => a - b);
    const rows = term.buffer.active.length;
    const rss = Number((rssMb() - before).toFixed(1));
    term.dispose();
    return { bytes, rows, ms: Number(samples[1]!.toFixed(2)), rss };
  };
  const five = await measured(5000, 5000);
  metrics.rows_5k = five.rows;
  metrics.snapshotBytes_5k = five.bytes;
  timings.snapshotMs_5k = five.ms;
  metrics.memoryRssMb_5k = five.rss;

  // Two builds at 50k so memory is reported as a range, not a single sample.
  const fiftyA = await measured(50_000, 50_000);
  const fiftyB = await measured(50_000, 50_000);
  metrics.rows_50k = fiftyA.rows;
  metrics.snapshotBytes_50k = fiftyA.bytes;
  timings.snapshotMs_50k = fiftyA.ms;
  metrics.memoryRssMb_50k_min = Math.min(fiftyA.rss, fiftyB.rss);
  metrics.memoryRssMb_50k_max = Math.max(fiftyA.rss, fiftyB.rss);
  set("metrics.snapshot50kLarger", metrics.snapshotBytes_50k! > metrics.snapshotBytes_5k!);
  set("metrics.reached50kRows", metrics.rows_50k! >= 50_000);

  // Measure the 1 MiB cap for real: serialize with a row cap, restore it, count the rows.
  const big = await fill(50_000, 50_000);
  let capBytes = 0;
  let capRows = 0;
  let capScrollback = 0;
  for (const rows of [20_000, 15_000, 10_000, 5000]) {
    const capped = big.addon.serialize({ scrollback: rows });
    const bytes = Buffer.byteLength(capped);
    if (bytes <= CAP) {
      const { term: cappedTerm } = restore(capped, COLS, ROWS, 50_000);
      await write(cappedTerm, capped);
      capBytes = bytes;
      capRows = cappedTerm.buffer.active.length;
      capScrollback = rows;
      cappedTerm.dispose();
      break;
    }
  }
  set("cap.fitsOneMiB", capScrollback > 0 && capBytes <= CAP);
  set("cap.truncatesRows", capRows > 0 && capRows <= capScrollback + ROWS + 5 && capRows < metrics.rows_50k!);
  metrics.capScrollback = capScrollback;
  metrics.capBytes = capBytes;
  metrics.capRows = capRows;
  big.term.dispose();
}

// --- what a hard kill with no snapshot loses -----------------------------------------------------
metrics.hostReplayBufferBytes = HOST_BUFFER;
metrics.lostBytesWithoutSnapshot = Math.max(0, stream.length - HOST_BUFFER);
set("hardKill.losesBytesWithoutSnapshot", (metrics.lostBytesWithoutSnapshot ?? 0) > 0);

// --- the attach-since contract, the resume-gap policy, and dedupe ---------------------------------
{
  const { client, adopted } = await ensureHost({ socket, checkout, buildId: "phase3" });
  set("contract.hostStartedFresh", adopted === false);

  // A snapshot from a killed incarnation must be rejected for the reopened one.
  const first = await client.open("inc", { cwd: checkout, command: ["/bin/sh", "-c", "sleep 30"] });
  const record: SnapshotRecord = { sessionId: "inc", incarnation: first.incarnation, highWater: 0, data: "snap" };
  await client.kill("inc");
  await sleep(100);
  const second = await client.open("inc", { cwd: checkout, command: ["/bin/sh", "-c", "sleep 30"] });
  set("incarnation.hostReopenRejected", !acceptSnapshot(record, "inc", second.incarnation));

  // A session that produces far more than the host's replay buffer.
  const emitter = `for(let i=0;i<12000;i++)process.stdout.write("line "+i+" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n");setTimeout(()=>{},8000)`;
  await client.open("contract", { cwd: checkout, command: [process.execPath, "-e", emitter] });
  const waitSeq = async (target: number): Promise<boolean> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (((await client.list()).find((session) => session.id === "contract")?.lastSeq ?? 0) >= target) return true;
      await sleep(25);
    }
    return false;
  };
  set("contract.producedEnough", await waitSeq(300_000));
  const stableSeq = async (): Promise<number> => {
    let last = -1;
    for (let i = 0; i < 100; i++) {
      const seq = (await client.list()).find((session) => session.id === "contract")?.lastSeq ?? 0;
      if (seq === last && seq >= 300_000) return seq;
      last = seq;
      await sleep(200);
    }
    return last;
  };
  const total = await stableSeq();
  set("contract.stable", total >= 300_000);

  // The snapshot high-water predates oldestSeq: the resume is truncated and the policy resets.
  const resumePlan = (truncated: boolean): "reset" | "replay" => (truncated ? "reset" : "replay");
  const fromStart = await client.attach("contract", 0);
  metrics.contractOldestSeq = fromStart.oldestSeq;
  metrics.contractLastSeq = total;
  set("gap.highWaterPredatesOldest", fromStart.oldestSeq > 0 && 0 < fromStart.oldestSeq);
  set("gap.truncatedResets", resumePlan(fromStart.truncated) === "reset");
  metrics.gapWorstCaseLossBytes = fromStart.oldestSeq;

  // Mid-buffer resume: no truncation, and the first replayed byte is exactly `since` (dedupe).
  const events: { seq: number; len: number }[] = [];
  client.onData("contract", (data, _incarnation, seq) => events.push({ seq, len: data.length }));
  const mid = await client.attach("contract", fromStart.oldestSeq + 10);
  await sleep(50);
  set("gap.midBufferReplays", !mid.truncated);
  set("gap.firstSeqAtOffset", events.length > 0 && events[0]!.seq === fromStart.oldestSeq + 10);
  set("gap.seqContiguous", events.every((event, at) => at === 0 || event.seq === events[at - 1]!.seq + events[at - 1]!.len));

  await client.kill("contract");
  await client.shutdown().catch(() => undefined);
}

metrics.rssMb = rssMb();
console.log(`READY ${JSON.stringify({ checks, metrics, timings, notes })}`);
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
