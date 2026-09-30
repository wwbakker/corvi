/**
 * The latest renderer-owned snapshot per `(sessionId, incarnation)`, held in memory.
 *
 * Phase 3 chose renderer-owned screen state: the page's xterm owns the buffer and serializes it,
 * and this store is the one place the server keeps a page's snapshot so a reconnect can replay it
 * before attaching. It holds `data` and the host byte offset it covers (`highWater`), never an
 * emulator — the server stays a relay. A server restart loses the store, which loses scrollback
 * back to the host's own ring; the host, and the shells in it, still survive.
 */
export type Snapshot = {
  /** The serialized terminal, written back through xterm on the page. */
  readonly data: string;
  /** The host byte offset the terminal had applied when this snapshot was taken. The page
   * attaches with `since = highWater`, so bytes after it are replayed, never doubled. */
  readonly highWater: number;
};

/** 1 MiB, the cap Phase 3 measured: the page serializes the most recent rows when a full
 * serialize would exceed it, and the server refuses an oversized one rather than hold it. */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

const snapshots = new Map<string, Snapshot>();
const keyOf = (sessionId: string, incarnation: number): string => `${sessionId}#${incarnation}`;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Store the page's latest snapshot, replacing any earlier one for the same session. An
 * oversized or empty snapshot is dropped: the page already trims, and a snapshot that cannot be
 * played back is worse than none. */
export const setSnapshot = (sessionId: string, incarnation: number, data: string, highWater: number): void => {
  if (typeof data !== "string" || data.length === 0) return;
  if (!Number.isFinite(highWater) || highWater < 0) return;
  if (byteLength(data) > SNAPSHOT_MAX_BYTES) return;
  snapshots.set(keyOf(sessionId, incarnation), { data, highWater: Math.floor(highWater) });
};

export const snapshotOf = (sessionId: string, incarnation: number): Snapshot | undefined =>
  snapshots.get(keyOf(sessionId, incarnation));

export const forgetSnapshot = (sessionId: string, incarnation: number): void => {
  snapshots.delete(keyOf(sessionId, incarnation));
};

/** Drop every snapshot. The server calls this when it shuts down; the hosts outlive it. */
export const clearSnapshots = (): void => {
  snapshots.clear();
};

/** Snapshot counts, for the tests that pin the cap and the per-incarnation key. */
export const snapshotStats = (): { snapshots: number } => ({ snapshots: snapshots.size });
