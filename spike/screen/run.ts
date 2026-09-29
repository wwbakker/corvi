/**
 * Phase 3 measurement runner. Feeds one recorded pty stream into a real (`@xterm/headless`) core
 * and compares two ways of restoring screen state:
 *
 *   (a) renderer-owned: the client holds the terminal, snapshots it, and on reconnect replays the
 *       snapshot then the pty output from the snapshot's high-water byte offset (`attach since`);
 *   (b) server-owned: a long-lived server terminal holds the state and serializes it on connect.
 *
 * Prints one `READY {json}` line with the checks, metrics and timings; `run.sh` asserts them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureHost } from "../terminal-host/client.ts";
import { feedBytes, makeTerminal, newSerializeAddon, restore, rowsText, snapshot, type SerializeAddon, type XtermTerminal } from "./xterm.ts";

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
const stream = readFileSync(fileURLToPath(new URL("./stream.bin", import.meta.url)));

const checks: Record<string, boolean> = {};
const set = (name: string, value: boolean): void => {
  checks[name] = value;
};
const metrics: Record<string, number> = {};
const timings: Record<string, number> = {};
const rssMb = (): number => Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));

const addonOf = (term: XtermTerminal): SerializeAddon => {
  const addon = newSerializeAddon();
  term.loadAddon(addon);
  return addon;
};

/** The same screen as the reference, by every measure the plan names. */
const compareToReference = (name: string, term: XtermTerminal, addon: SerializeAddon, reference: XtermTerminal, refAddon: SerializeAddon): void => {
  const buffer = term.buffer.active;
  const refBuffer = reference.buffer.active;
  set(`${name}.cursor`, buffer.cursorX === refBuffer.cursorX && buffer.cursorY === refBuffer.cursorY);
  set(`${name}.scroll`, buffer.baseY === refBuffer.baseY && buffer.viewportY === refBuffer.viewportY);
  const rows = rowsText(term);
  const refRows = rowsText(reference);
  set(`${name}.rows`, rows.length === refRows.length && rows.every((row, at) => row === refRows[at]));
  set(`${name}.serialized`, snapshot(term, addon) === snapshot(reference, refAddon));
};

// The reference screen: the whole stream, in small chunks so escapes and UTF-8 split.
const reference = makeTerminal(COLS, ROWS, SCROLLBACK);
const refAddon = addonOf(reference);
await feedBytes(reference, stream, 7);
metrics.referenceRows = reference.buffer.active.length;

// --- (a) renderer-owned --------------------------------------------------------------------------
{
  const snapshotAt = Math.floor(stream.length * 0.6);
  const live = makeTerminal(COLS, ROWS, SCROLLBACK);
  const liveAddon = addonOf(live);
  await feedBytes(live, stream.subarray(0, snapshotAt), 7);
  const snap = snapshot(live, liveAddon);
  metrics.rendererSnapshotBytes = Buffer.byteLength(snap);
  metrics.rendererHighWater = snapshotAt;

  // "Reconnect": fresh terminal, snapshot first, then pty output from the high-water offset.
  const { term: restoredTerm, addon: restoredAddon } = restore(snap, COLS, ROWS, SCROLLBACK);
  restoredTerm.write(snap);
  await new Promise<void>((resolve) => restoredTerm.write("", () => resolve()));
  await feedBytes(restoredTerm, stream.subarray(snapshotAt), 7);
  compareToReference("renderer", restoredTerm, restoredAddon, reference, refAddon);
  // No duplicated or lost bytes: the restored screen is byte-for-byte the reference screen.
  set("renderer.noDuplicateOrLoss", snapshot(restoredTerm, restoredAddon) === snapshot(reference, refAddon));
}

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
  clientTerm.write(snap);
  await new Promise<void>((resolve) => clientTerm.write("", () => resolve()));
  compareToReference("server", clientTerm, clientAddon, reference, refAddon);
  metrics.serverRows = server.buffer.active.length;
}

// --- snapshot size/time and memory at 5k and 50k rows --------------------------------------------
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
for (const [label, scrollback, target] of [["5k", 5000, 5000], ["50k", 50_000, 50_000]] as const) {
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
  metrics[`rows_${label}`] = term.buffer.active.length;
  metrics[`snapshotBytes_${label}`] = bytes;
  timings[`snapshotMs_${label}`] = Number(samples[1]!.toFixed(2));
  metrics[`memoryRssMb_${label}`] = Number((rssMb() - before).toFixed(1));
  term.dispose();
}
set("metrics.snapshot50kLarger", metrics.snapshotBytes_50k! > metrics.snapshotBytes_5k!);
set("metrics.reached50kRows", metrics.rows_50k! >= 50_000);

// --- what a hard kill with no snapshot loses -----------------------------------------------------
metrics.streamBytes = stream.length;
metrics.hostReplayBufferBytes = HOST_BUFFER;
metrics.lostBytesWithoutSnapshot = Math.max(0, stream.length - HOST_BUFFER);
set("hardKill.losesBytesWithoutSnapshot", (metrics.lostBytesWithoutSnapshot ?? 0) > 0);

// --- the attach-since contract (the high-water offset rides on it) --------------------------------
{
  const { client, adopted } = await ensureHost({ socket, checkout, buildId: "phase3" });
  set("contract.hostStartedFresh", adopted === false);
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
  // Wait for the emitter to go quiet so `oldestSeq` is not racing further output; then the
  // newest offset is a stable high-water mark.
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
  const fromStart = await client.attach("contract", 0);
  metrics.contractOldestSeq = fromStart.oldestSeq;
  metrics.contractLastSeq = total;
  set("contract.truncatedWhenOld", fromStart.truncated && fromStart.oldestSeq > 0);
  const resume = await client.attach("contract", total);
  set("contract.resumeNotTruncated", !resume.truncated);
  await client.kill("contract");
  await client.shutdown().catch(() => undefined);
}

metrics.rssMb = rssMb();
console.log(`READY ${JSON.stringify({ checks, metrics, timings })}`);
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
