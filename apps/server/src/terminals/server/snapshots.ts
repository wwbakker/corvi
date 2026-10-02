/**
 * The persisted server-owned screens, per `(sessionId, incarnation)`.
 *
 * The hub (`./session.ts`) writes a screen here while it is dirty on a cadence and synchronously
 * on a controlled shutdown. `server.ts` loads the store on start; when a screen is created for a
 * session the hub seeds it from the stored entry and attaches the host from the stored offset, so
 * deep scrollback survives a Corvi restart even past the host's 256 KiB ring. Dead incarnations
 * are pruned by the windows layer (`pruneSnapshots`) down to the live and kept-open keys.
 *
 * A snapshot is `data` plus the host byte offset it covers (`highWater`), keyed by incarnation so
 * a reused session id never inherits its predecessor's screen. The shape is the one the page's
 * store used; the writer is now the hub (`./session.ts`), and the decision is
 * `docs/decisions/server-owned-screen.md`.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "@corvi/configuration/node";

export type Snapshot = {
  /** The serialized screen, replayed into a headless xterm (or a page) to reconstruct it. */
  readonly data: string;
  /** The host byte offset the screen had applied when this was taken. A host attach resumes from
   * it, so bytes after it are replayed, never doubled. */
  readonly highWater: number;
  /** When the snapshot was stored, for the total-size eviction order. */
  readonly savedAt: number;
};

/** 1 MiB, the cap Phase 3 measured: the screen serializes its most recent rows when a full
 * serialize would exceed it, and the store refuses an oversized one rather than hold it. */
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

export type SnapshotInput = {
  readonly sessionId: string;
  readonly incarnation: number;
  readonly data: string;
  readonly highWater: number;
};

/** Whether a serialization is worth storing: non-empty, finite offset, within the cap. */
const acceptable = (data: string, highWater: number): boolean =>
  typeof data === "string" &&
  data.length > 0 &&
  Number.isFinite(highWater) &&
  highWater >= 0 &&
  byteLength(data) <= SNAPSHOT_MAX_BYTES;

/** Store one screen's serialization. */
export const setSnapshot = (sessionId: string, incarnation: number, data: string, highWater: number): void => {
  setSnapshots([{ sessionId, incarnation, data, highWater }]);
};

/** Store a batch, replacing any earlier entry per session and persisting the file once: a cadence
 * tick with several dirty screens should not rewrite the whole store once per screen. An
 * unacceptable entry is skipped; the caller keeps its screen dirty so the next tick retries. */
export const setSnapshots = (entries: readonly SnapshotInput[]): void => {
  let changed = false;
  const savedAt = Date.now();
  for (const entry of entries) {
    if (!acceptable(entry.data, entry.highWater)) continue;
    snapshots.set(keyOf(entry.sessionId, entry.incarnation), {
      data: entry.data,
      highWater: Math.floor(entry.highWater),
      savedAt,
    });
    changed = true;
  }
  if (!changed) return;
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
