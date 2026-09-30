/**
 * The latest renderer-owned snapshot per `(sessionId, incarnation)`, held in memory and persisted
 * to the state dir.
 *
 * Phase 3 chose renderer-owned screen state: the page's xterm owns the buffer and serializes it,
 * and this store is the one place the server keeps a page's snapshot so a reconnect can replay it
 * before attaching. It holds `data` and the host byte offset it covers (`highWater`), never an
 * emulator — the server stays a relay. Persisting it is what makes the flagship "restart Corvi and
 * the terminal is still there" keep its scrollback past the host's 256 KiB ring; the shells
 * themselves are the host's.
 *
 * A snapshot is keyed by incarnation, so a reused session id never inherits its predecessor's
 * screen. Dead incarnations are pruned by the windows layer (`pruneSnapshots`), which knows which
 * records asked to be kept open (`keepOpen`) and must keep their frozen output.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "@corvi/configuration/node";

export type Snapshot = {
  /** The serialized terminal, written back through xterm on the page. */
  readonly data: string;
  /** The host byte offset the terminal had applied when this snapshot was taken. The page
   * attaches with `since = highWater`, so bytes after it are replayed, never doubled. */
  readonly highWater: number;
  /** When the snapshot was stored, for the total-size eviction order. */
  readonly savedAt: number;
};

/** 1 MiB, the cap Phase 3 measured: the page serializes the most recent rows when a full
 * serialize would exceed it, and the server refuses an oversized one rather than hold it. */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** The whole store's persisted budget. Above it the oldest snapshots are evicted; a handful of
 * live sessions fits easily, and the file cannot grow without bound. */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const FILE = "terminal-snapshots.json";
const path = (): string => join(stateDir(), FILE);
const keyOf = (sessionId: string, incarnation: number): string => `${sessionId}#${incarnation}`;
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const snapshots = new Map<string, Snapshot>();
let loaded = false;

/** Read the persisted store once, treating anything unreadable as empty: a corrupt file is a
 * reset, not a server failure. */
export const loadSnapshots = (): void => {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as {
      version?: unknown;
      snapshots?: Record<string, Partial<Snapshot>>;
    };
    if (parsed.version !== 1 || typeof parsed.snapshots !== "object" || parsed.snapshots === null) return;
    for (const [key, value] of Object.entries(parsed.snapshots)) {
      if (typeof value.data !== "string" || typeof value.highWater !== "number") continue;
      if (!Number.isFinite(value.highWater) || value.highWater < 0) continue;
      if (byteLength(value.data) === 0 || byteLength(value.data) > SNAPSHOT_MAX_BYTES) continue;
      snapshots.set(key, {
        data: value.data,
        highWater: Math.floor(value.highWater),
        savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
      });
    }
  } catch {
    // no file yet
  }
};

/** Write the store atomically: a reader sees the old file or the new one, never a half-written. */
const persist = (): void => {
  const out: Record<string, Snapshot> = {};
  for (const [key, value] of snapshots) out[key] = value;
  mkdirSync(dirname(path()), { recursive: true });
  const tmp = `${path()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, snapshots: out }));
  renameSync(tmp, path());
};

/** Drop oldest snapshots until the store fits its budget. */
const evictToBudget = (): void => {
  let total = 0;
  for (const value of snapshots.values()) total += byteLength(value.data);
  if (total <= MAX_TOTAL_BYTES) return;
  const oldestFirst = [...snapshots.entries()].sort((left, right) => left[1].savedAt - right[1].savedAt);
  for (const [key, value] of oldestFirst) {
    if (total <= MAX_TOTAL_BYTES) break;
    total -= byteLength(value.data);
    snapshots.delete(key);
  }
};

/** Store the page's latest snapshot, replacing any earlier one for the same session. An
 * oversized or empty snapshot is dropped: the page already trims, and a snapshot that cannot be
 * played back is worse than none. */
export const setSnapshot = (sessionId: string, incarnation: number, data: string, highWater: number): void => {
  if (typeof data !== "string" || data.length === 0) return;
  if (!Number.isFinite(highWater) || highWater < 0) return;
  if (byteLength(data) > SNAPSHOT_MAX_BYTES) return;
  snapshots.set(keyOf(sessionId, incarnation), { data, highWater: Math.floor(highWater), savedAt: Date.now() });
  evictToBudget();
  persist();
};

export const snapshotOf = (sessionId: string, incarnation: number): Snapshot | undefined =>
  snapshots.get(keyOf(sessionId, incarnation));

export const forgetSnapshot = (sessionId: string, incarnation: number): void => {
  if (!snapshots.delete(keyOf(sessionId, incarnation))) return;
  persist();
};

/** Keep only the snapshots whose `(id, incarnation)` is in `liveKeys`, which the windows layer
 * builds from live sessions and kept-open dead ones. */
export const pruneSnapshots = (liveKeys: ReadonlySet<string>): void => {
  loadSnapshots();
  let changed = false;
  for (const key of [...snapshots.keys()]) {
    if (liveKeys.has(key)) continue;
    snapshots.delete(key);
    changed = true;
  }
  if (changed) persist();
};

/** Drop every snapshot and the persisted file, and go back to the unloaded state so a later
 * `loadSnapshots` re-reads whatever is on disk. The tests reset with this; it is not a shutdown
 * hook — the persisted store is what a restart loads back. */
export const clearSnapshots = (): void => {
  snapshots.clear();
  loaded = false;
  rmSync(path(), { force: true });
};

/** Snapshot counts, for the tests that pin the cap and the per-incarnation key. */
export const snapshotStats = (): { snapshots: number } => ({ snapshots: snapshots.size });

/** The `(id, incarnation)` keys the tests and the prune use. */
export const snapshotKey = keyOf;
