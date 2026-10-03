/**
 * The WebSocket's terminal half: the server-owned screen and the hub that feeds it.
 *
 * One hub exists per `(sessionId, incarnation)`. It owns the single host attachment for that
 * session — always, while the screen exists, not only while a page is attached — feeds every host
 * byte into a headless xterm (`./screen.ts`), and serves pages from it. A page that connects gets
 * a `snapshot` of the serialized screen with the host byte offset it covers, then the live bytes
 * after that offset. The page sends only input and `resize`; the offset is the server's.
 *
 * The race an attach has to close: bytes that arrive between serializing the screen and
 * registering the subscriber. `subscribe` holds those bytes — they are not fed to the screen —
 * until the snapshot has been sent and the subscriber registered, then replays them in order, so
 * the page sees the screen as of the snapshot and every byte after it, once.
 *
 * `kill()` means detach, never kill: closing a page leaves the shell and the screen running, and
 * the host listener stays because the screen exists. The exit of the session ends the hub.
 *
 * Persistence: a screen is written to `./snapshots.ts` while it is dirty on a cadence, and
 * synchronously on a controlled shutdown — **except an agent session** (`metadata.subagentId`),
 * which reprints its whole view when its pty is jiggled, so it is attached (and jiggled) on first
 * view instead of being serialized on a schedule; only a dead kept-open one is written on exit. A
 * screen with no page for a short grace is released —
 * the store keeps it, so a later attach still resumes, and the server drops its host attachment.
 * That grace is the CPU bound: a window is parsed while its startup is captured and while a page is
 * looking, not for as long as its shell paints. (The host's own idle timeout is disabled while the
 * server holds its connection, so this release is what frees the host's interest; the host idles
 * once the server exits.) On creation a screen is seeded from the store and the host attaches from
 * the stored offset; see `hubFor` for the gap policy and its visible cost. "Exact" here is
 * screen-content exact: the serializer restores the text and the modes it knows, not every parser
 * state, and the stored offset can fall mid-escape.
 *
 * The socket protocol, chosen so neither direction can be mistaken for the other:
 *
 *   - page to server: binary is what you typed; text is JSON control (`resize`);
 *   - server to page: binary is terminal output; text is JSON control (`snapshot` with the
 *     serialized screen, `reset` when the screen is empty, `exit` when the session is gone and no
 *     reconnect should follow).
 */
import type { HostClient } from "../host/client.ts";
import { appendFileSync } from "node:fs";
import { hostClient } from "./host.ts";
import { makeScreen, type Screen, type ScreenSnapshot } from "./screen.ts";
import { SNAPSHOT_MAX_BYTES, forgetSnapshot, setSnapshots, snapshotOf, type SnapshotInput } from "./snapshots.ts";
import { ensureActiveHostWindow, isKeptOpen } from "./windows.ts";

/** How often a dirty screen is written to the store. Serializing a 5,000-row screen is ~17 ms and
 * only dirty screens are serialized, so a busy session costs at most one such write per cadence
 * and a quiet one costs nothing. The shutdown flush makes the last moments exact regardless. A
 * test can shorten it with `CORVI_SCREEN_CADENCE_MS`. */
const SNAPSHOT_CADENCE_MS = 5000;
/** A screen with no page is released this long after the last page left (or after it opened, when
 * no page ever attached): the store keeps it for a later attach, and the host is left holding
 * nothing. This is the CPU bound for unattended screens — a window is parsed while its startup is
 * captured and while you are looking, not forever. A test can shorten it with
 * `CORVI_SCREEN_IDLE_MS`. */
const SCREEN_UNATTENDED_MS = 10_000;
/** The largest batch of host bytes fed to the screen in one turn. A turn that reaches it flushes
 * at once, so a flood cannot grow a batch without bound. */
const MAX_BATCH_BYTES = 256 * 1024;
/** A first-view repaint must be quiet this long before it is served: a full-screen program
 * re-emits its view on the resize jiggle, and we wait for that burst to stop (capped) rather than
 * guess a duration. A test can shorten both with `CORVI_REPAINT_QUIET_MS`/`CORVI_REPAINT_MAX_MS`. */
const REPAINT_QUIET_MS = 120;
const REPAINT_START_MS = 600;
const REPAINT_MAX_MS = 4000;
const repaintQuietMs = (): number => envMs("CORVI_REPAINT_QUIET_MS", REPAINT_QUIET_MS);
const repaintStartMs = (): number => envMs("CORVI_REPAINT_START_MS", REPAINT_START_MS);
const repaintMaxMs = (): number => envMs("CORVI_REPAINT_MAX_MS", REPAINT_MAX_MS);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** The lifecycle sweep's tick: it decides whether each screen is due to persist or to be released.
 * Cheap (it iterates hubs), so the cadence and timeout can be read per tick. */
const SWEEP_TICK_MS = 250;

const cadenceMs = (): number => envMs("CORVI_SCREEN_CADENCE_MS", SNAPSHOT_CADENCE_MS);
const unattendedMs = (): number => envMs("CORVI_SCREEN_IDLE_MS", SCREEN_UNATTENDED_MS);

/** Append a terminal failure to the app log (or stderr), so a page reporting "the session is gone"
 * can be traced to the serve that failed. */
const logFailure = (message: string, error: unknown): void => {
  const text = `[terminals] ${message}: ${error instanceof Error ? error.message : String(error)}`;
  const log = process.env.CORVI_LOG;
  try {
    if (log !== undefined && log !== "") appendFileSync(log, `[${new Date().toISOString()}] ${text}\n`);
    else console.error(text);
  } catch {
    // a failure to log a failure is still not a crash
  }
};

/** A millisecond override from the environment, or the fallback. `Number(x) || fallback` cannot
 * express `0`, which a test may want. */
const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const onBun = (process.versions as Record<string, string | undefined>).bun !== undefined;

/** Why a terminal cannot start here, if it cannot. The route asks first, so the pane shows the
 * reason instead of opening a socket that never speaks. A server on Bun with a Node host runtime
 * (`CORVI_HOST_RUNTIME`, the tests' seam) is fine: the pty is delivered by the Node host. */
export const terminalUnavailable = (): string | undefined =>
  onBun && process.env.CORVI_HOST_RUNTIME === undefined
    ? "the terminal needs Node — Bun never delivers pty output; run the server with Node (`bun run dev` does)"
    : undefined;

type Subscriber = {
  /** One output chunk, as the bytes the host delivered. */
  readonly send: (chunk: Uint8Array) => void;
  /** The serialized screen and the host offset it covers, sent before any live byte. */
  readonly snapshot: (frame: { readonly data: string; readonly offset: number }) => void;
  readonly onExit: () => void;
  /** Set when the page leaves before its attach finished, so a freshly attached screen is not
   * pinned by a socket that is already gone. */
  cancelled: boolean;
};

type DataListener = (data: Buffer, incarnation: number, seq: number) => void;
type ExitListener = (exitCode: number, signal: number, incarnation: number) => void;

/** A host chunk held while a page attach serializes. */
type Held = { readonly seq: number; readonly data: Buffer };

/** How a screen is persisted and first viewed. An agent session reprints its whole view on a pty
 * resize, so it is not persisted on the cadence and is attached only on first view; a dead
 * kept-open one has its frozen screen in the store.
 *
 * `reprintable` is **provenance-based**: it comes from the host session's `metadata.subagentId`
 * (which survives a server restart, since the host outlives the server). A hand-run TUI — htop, or
 * pi started at a prompt — has no such metadata and stays on the cadence path: correct, but it
 * keeps paying the per-cadence serialization. */
export type ScreenOrigin = { readonly reprintable: boolean; readonly dead: boolean };

const plainOrigin: ScreenOrigin = { reprintable: false, dead: false };

type Hub = {
  /** `sessionId#incarnation`: a reused session id gets a fresh hub and screen. */
  readonly key: string;
  /** The change the window belongs to, for the keep-open check on exit. */
  readonly changeId: string;
  readonly id: string;
  incarnation: number;
  readonly screen: Screen;
  /** An agent session that reprints itself: no cadence persistence, and the host attach (and the
   * resize jiggle that forces the reprint) happens on first view, not at window open. */
  readonly reprintable: boolean;
  /** A reprintable hub has had its first-view attach and jiggle; a later viewer reuses it. */
  repainted: boolean;
  /** The grid the page wants. `repaintHub` shrinks the pty and grows back to **this**, so a resize
   * that lands during the repaint is not clobbered by the captured size. */
  desiredCols: number;
  desiredRows: number;
  readonly subscribers: Set<Subscriber>;
  /** The host offset of the last byte received (fed to the screen, or held for an attach). */
  received: number;
  exited: boolean;
  /** Registered at open and kept while the screen exists, so the screen stays fed with no page. */
  dataListener?: DataListener;
  /** Registered at open and kept until the session exits. */
  exitListener?: ExitListener;
  /** The client the listeners belong to, for removal. */
  client?: HostClient;
  attaching?: Promise<void>;
  /** While a page is attaching: the bytes after its cutoff, held until the snapshot is sent and
   * the subscriber registered. Set synchronously with `attachingPage`, which is the claim. */
  hold?: Held[];
  /** An attach has claimed the hub (its guard and claim are one synchronous step); the session's
   * exit waits for it to finish. */
  attachingPage?: boolean;
  /** The newest page waiting for an in-flight attach to settle. The first-view repaint can hold
   * the attach for seconds, so a newcomer (the page's unnamed→named rename, a second tab) is queued
   * here rather than answered with a final `exit`. */
  queued?: Subscriber;
  /** The screen changed since it was last written to the store. */
  dirty: boolean;
  /** Host bytes received but not yet fed to the screen, coalesced into one write/send per turn. */
  pending: Held[];
  /** The bytes in `pending`, for the batch bound. */
  pendingBytes: number;
  /** A flush is queued for this turn. */
  flushScheduled: boolean;
  /** When the last page left — or when the screen opened, if no page ever attached — for the
   * unattended release. Undefined while a page is attached. */
  unattendedSince?: number;
  /** When the screen was last written to the store, for the cadence. */
  lastPersist: number;
  /** The screen has been disposed; a stale `TerminalSession` must not attach to it. */
  disposed?: boolean;
  /** The host ring's join from the attach reply: where its oldest retained byte is and whether the
   * replay was truncated. The ring tail can begin mid-escape, so this records the join for
   * diagnostics and a future "history before X"; it is not needed for the resume itself. */
  ring?: { readonly oldestSeq: number; readonly truncated: boolean };
};

const hubs = new Map<string, Hub>();

/** Get-or-create synchronously: two concurrent opens of one incarnation cannot each make a hub. */
const hubFor = (
  changeId: string,
  id: string,
  incarnation: number,
  size: { readonly cols: number; readonly rows: number },
  origin: ScreenOrigin = plainOrigin,
): Hub => {
  const key = `${id}#${incarnation}`;
  const existing = hubs.get(key);
  if (existing !== undefined) {
    // The first creation wins; the classifier is provenance-based, so a disagreement means the
    // metadata changed underneath a live hub (or two callers disagree). Say so rather than silently
    // keeping either answer.
    if (existing.reprintable !== origin.reprintable) {
      console.error(
        `[terminals] ${key} is already ${existing.reprintable ? "reprintable" : "persisted"}, not the newly reported ${origin.reprintable ? "reprintable" : "persisted"}`,
      );
    }
    return existing;
  }
  const hub: Hub = {
    key,
    changeId,
    id,
    incarnation,
    screen: makeScreen(size),
    reprintable: origin.reprintable,
    repainted: false,
    desiredCols: size.cols,
    desiredRows: size.rows,
    subscribers: new Set(),
    received: 0,
    exited: false,
    dirty: false,
    pending: [],
    pendingBytes: 0,
    flushScheduled: false,
    unattendedSince: Date.now(),
    lastPersist: 0,
  };
  // Seed the screen from the store when one exists for this exact incarnation. A **live**
  // reprintable hub never reads the store — it reconstructs its view from the host on first view —
  // but a dead kept-open one seeded from its frozen exit screen does. The host then attaches from
  // `received` (the stored offset), so one server's resume is exact — with the caveats in the
  // module and `screen.ts` docs: "exact" is the screen content the serializer can restore (text and
  // the modes it knows, not every parser state, and the stored offset can fall mid-escape). Gap
  // policy: when the host's ring has already evicted past the stored offset, there is a hole
  // between it and the ring's oldest byte. We keep the deep screen and let the ring's incremental
  // bytes land on top of it rather than rebuild — the store exists for deep history, and rebuilding
  // would forfeit it. The visible cost is that those incremental bytes address a screen state from
  // an older offset, so a TUI that never fully redraws can look scrambled until its next paint; the
  // hole is bounded by the 256 KiB ring, not by the missing span. `screen.write`'s monotonic offset
  // keeps the ring's older seqs from pulling the stored high-water back.
  const stored = origin.reprintable && !origin.dead ? undefined : snapshotOf(id, incarnation);
  if (stored !== undefined && stored.data !== "") {
    // Seed across geometry can reflow: a screen stored at one grid size, seeded into a window the
    // page now shows at another, is reflowed by the headless terminal. The P3 record should say so.
    hub.screen.seed(stored.data, stored.highWater);
    hub.received = stored.highWater;
    hub.lastPersist = Date.now();
  }
  hubs.set(key, hub);
  return hub;
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** What a dirty screen yields for the store: an `input` to write, `"empty"` when the screen is
 * genuinely empty (so any stored entry is dropped), or undefined when there is nothing to do — a
 * clean screen, a serializer that threw, or a serialization too large for the store's cap, in
 * which case the previous entry is kept and the screen stays dirty. */
const screenSnapshot = (hub: Hub): SnapshotInput | "empty" | undefined => {
  if (!hub.dirty) return undefined;
  let snapshot: ScreenSnapshot;
  try {
    snapshot = hub.screen.serialize();
  } catch {
    return undefined;
  }
  if (snapshot.data === "") return "empty";
  if (byteLength(snapshot.data) > SNAPSHOT_MAX_BYTES) return undefined;
  return { sessionId: hub.id, incarnation: hub.incarnation, data: snapshot.data, highWater: snapshot.offset };
};

/** Mark screens stored: `dirty` clears only after the write succeeded; `lastPersist` always moves,
 * so a failed write retries on the next cadence rather than on every tick. */
const markStored = (entries: readonly { readonly hub: Hub }[], at: number, stored: boolean): void => {
  for (const { hub } of entries) {
    hub.lastPersist = at;
    if (stored) hub.dirty = false;
  }
};

/** Write one dirty screen (exit, idle release). */
const persistScreen = (hub: Hub): void => {
  const result = screenSnapshot(hub);
  if (result === undefined) return;
  if (result === "empty") {
    if (forgetSnapshot(hub.id, hub.incarnation)) hub.dirty = false;
    return;
  }
  markStored([{ hub }], Date.now(), setSnapshots([result]));
};

/** Write every dirty screen in one pass, for the controlled shutdown. Synchronous on purpose: a
 * signal handler has no time to await, and the store persists with a rename. */
export const flushScreens = (): void => {
  const due: { hub: Hub; input: SnapshotInput }[] = [];
  const empty: Hub[] = [];
  for (const hub of hubs.values()) {
    // A reprintable hub is never persisted on a schedule; a dead kept-open one was written on exit.
    if (hub.reprintable) continue;
    const result = screenSnapshot(hub);
    if (result === "empty") empty.push(hub);
    else if (result !== undefined) due.push({ hub, input: result });
  }
  if (due.length > 0) {
    markStored(due, Date.now(), setSnapshots(due.map((entry) => entry.input)));
  }
  for (const hub of empty) {
    if (forgetSnapshot(hub.id, hub.incarnation)) hub.dirty = false;
  }
};

/** Drop a screen without killing its shell: release the host attachment, mark it disposed so a
 * stale `TerminalSession` cannot attach to it, and forget the hub. A later attach reseeds from
 * the store. */
const releaseScreen = (hub: Hub): void => {
  release(hub);
  watchExitOff(hub);
  hub.disposed = true;
  hub.screen.dispose();
  hubs.delete(hub.key);
};

/** The lifecycle tick: persist dirty screens on the cadence, release screens a timeout past their
 * last activity. Cheap enough to run often, so both intervals can be read per tick (and shortened
 * by a test). One store write per tick however many screens are due. */
const sweep = (): void => {
  const now = Date.now();
  const cadence = cadenceMs();
  const unattended = unattendedMs();
  const due: { hub: Hub; input: SnapshotInput }[] = [];
  const empty: Hub[] = [];
  const releasing: Hub[] = [];
  const failed = new Set<Hub>();
  for (const hub of [...hubs.values()]) {
    if (hub.attachingPage) continue; // an in-flight attach owns the screen right now
    // Unattended: no page has looked for the grace. Output does not postpone this — stopping the
    // parse is the point — only a page does.
    const unattendedNow =
      hub.subscribers.size === 0 && hub.unattendedSince !== undefined && now - hub.unattendedSince >= unattended;
    // A reprintable hub is never serialized or written on the cadence: it reconstructs its view on
    // first view, and the store only ever holds a dead kept-open one's frozen exit screen.
    if (hub.reprintable) {
      if (unattendedNow) releasing.push(hub);
      continue;
    }
    const dueForCadence = hub.dirty && now - hub.lastPersist >= cadence;
    if (!dueForCadence && !unattendedNow) continue;
    const result = screenSnapshot(hub); // persist before releasing, so nothing is lost
    if (result === "empty") empty.push(hub);
    else if (result !== undefined) due.push({ hub, input: result });
    if (unattendedNow) releasing.push(hub);
  }
  if (due.length > 0) {
    const stored = setSnapshots(due.map((entry) => entry.input));
    markStored(due, now, stored);
    if (!stored) for (const { hub } of due) failed.add(hub);
  }
  for (const hub of empty) {
    if (forgetSnapshot(hub.id, hub.incarnation)) hub.dirty = false;
    else failed.add(hub);
  }
  // A screen is released only once its state is on disk: a failed write keeps it for the next
  // attempt rather than dropping history. A screen the store cannot hold at all (over-cap, or a
  // serializer that threw) is not a write failure — the previous entry stands, and it is released.
  for (const hub of releasing) {
    if (!failed.has(hub)) releaseScreen(hub);
  }
};

// The sweep is the only timer the module owns; it must not keep a test process alive.
setInterval(sweep, SWEEP_TICK_MS).unref();

/** Record attendance: a screen with a page is attended (its clock cleared); with none, the
 * unattended clock runs from now, so the sweep releases it after the grace. */
const noteAttendance = (hub: Hub): void => {
  hub.unattendedSince = hub.subscribers.size > 0 ? undefined : Date.now();
};

/** Tell the hub's live client the session is gone and forget the hub — unless the window asked to
 * be kept open, whose frozen screen stays for a later look. */
const finish = (hub: Hub): void => {
  const subscribers = [...hub.subscribers];
  hub.subscribers.clear();
  noteAttendance(hub);
  release(hub);
  if (!isKeptOpen(hub.changeId, hub.id)) {
    hub.disposed = true;
    hub.screen.dispose();
    hubs.delete(hub.key);
  }
  for (const subscriber of subscribers) subscriber.onExit();
};

/** The exit of a session ends the hub whenever it happens, page or no page. An attach that is
 * serializing the last screen is allowed to finish first, so it serves what the session left. */
const onSessionExit = (hub: Hub) => (): void => {
  if (hub.exited) return;
  hub.exited = true;
  watchExitOff(hub);
  const kept = isKeptOpen(hub.changeId, hub.id);
  // The session's last screen is worth keeping before the hub lets go: a kept-open window's frozen
  // output survives a restart through it. A reprintable hub is normally not persisted at all, but a
  // kept-open one cannot reprint once dead, so its final screen is written here.
  if (!hub.reprintable || kept) persistScreen(hub);
  // A dead session emits nothing: stop listening now. An attach serializing the last screen is
  // allowed to finish first, so it serves what the session left.
  release(hub);
  if (hub.attachingPage) return;
  if (hub.subscribers.size > 0) {
    finish(hub);
    return;
  }
  // No page: the screen may still be wanted, but only a kept-open window froze its output on
  // purpose. P2 owns the full eviction policy; this is the cheap stopgap for the rest.
  if (!kept) {
    hub.disposed = true;
    hub.screen.dispose();
    hubs.delete(hub.key);
  }
};

const watchExit = (hub: Hub, client: HostClient): void => {
  if (hub.exitListener !== undefined) return;
  hub.client = client;
  hub.exitListener = onSessionExit(hub);
  client.onExit(hub.id, hub.exitListener);
};

const watchExitOff = (hub: Hub): void => {
  if (hub.client === undefined || hub.exitListener === undefined) return;
  hub.client.offExit(hub.id, hub.exitListener);
  hub.exitListener = undefined;
};

/** Remove the host data listener. Called on exit and on the tests' reset; never on detach, because
 * the screen exists whether or not a page is attached. */
const release = (hub: Hub): void => {
  if (hub.client !== undefined && hub.dataListener !== undefined) {
    hub.client.offData(hub.id, hub.dataListener);
  }
  hub.dataListener = undefined;
};

/** Feed one turn's host bytes to the screen and the page in a single write and a single send:
 * fewer parser passes and frames than one per host chunk. Bounded: the listener flushes at once
 * when the batch reaches `MAX_BATCH_BYTES`, so a flood cannot grow it without limit. */
const flushHub = (hub: Hub): void => {
  hub.flushScheduled = false;
  if (hub.pending.length === 0 || hub.disposed === true) return;
  const chunks = hub.pending;
  hub.pending = [];
  hub.pendingBytes = 0;
  const first = chunks[0]!;
  const bytes = chunks.length === 1 ? first.data : Buffer.concat(chunks.map((chunk) => chunk.data));
  if (hub.hold !== undefined) {
    hub.hold.push({ seq: first.seq, data: bytes });
    return;
  }
  hub.screen.write(bytes, first.seq);
  for (const subscriber of hub.subscribers) subscriber.send(bytes);
};

/** Wait until the host has been quiet for a period (capped), so one burst of output is finished
 * before the next step. */
const settleQuiet = async (hub: Hub, deadline = Date.now() + repaintMaxMs()): Promise<void> => {
  let seen = hub.received;
  for (;;) {
    await sleep(repaintQuietMs());
    if (hub.received === seen) return;
    seen = hub.received;
    if (Date.now() >= deadline) return;
  }
};

/** Force a full-screen program to reprint its whole view by jiggling its pty size, then wait for
 * the burst to settle. The headless screen is resized in step, so the snapshot is taken at the grid
 * the program reprinted at. (Measured against a live pi: the jiggle re-emits the whole view, and a
 * blank screen fed only those bytes reconstructs the viewport.)
 *
 * `hub.hold` is deliberately **not** set here: the reprint's bytes must be fed to the screen, not
 * held for a snapshot cut before them — the caller holds only after this returns. */
const repaintHub = async (hub: Hub): Promise<void> => {
  const client = await hostClient();
  // One deadline for both settles (the ring's and the reprint's), so the worst case is the cap, not
  // twice it.
  const deadline = Date.now() + repaintMaxMs();
  // The host's ring replay (the base) arrives just after the attach reply: let it land before the
  // jiggle, so the reprint's bytes are told apart from it.
  await settleQuiet(hub, deadline);
  const shrunken = Math.max(1, hub.desiredCols - 1);
  await client.resize(hub.id, shrunken, hub.desiredRows).catch(() => undefined);
  hub.screen.resize(shrunken, hub.desiredRows);
  // Grow back to the grid the page wants **now**: a resize may have landed during the jiggle, and
  // restoring the captured size would strand the pty on a grid the ResizeObserver will not re-fit.
  await client.resize(hub.id, hub.desiredCols, hub.desiredRows).catch(() => undefined);
  hub.screen.resize(hub.desiredCols, hub.desiredRows);
  // Wait for the reprint to begin (the SIGWINCH round trip and the program's redraw are not
  // instantaneous; a program that ignores the resize never starts), then for it to stop.
  const before = hub.received;
  const startDeadline = Date.now() + repaintStartMs();
  while (hub.received === before && Date.now() < startDeadline) await sleep(15);
  await settleQuiet(hub, deadline);
};

/** Attach to the host once, from the offset already received, and feed every byte to the screen.
 * The screen starts empty and the host replays its ring, so this is the session's whole history
 * the ring still holds; the first chunk's `seq` anchors the screen's offset. A failed attach
 * releases the listener and rethrows, so the hub stays retryable. */
const ensureAttached = async (hub: Hub): Promise<void> => {
  if (hub.dataListener !== undefined) return;
  if (hub.attaching !== undefined) return hub.attaching;
  const promise = (async (): Promise<void> => {
    const client = await hostClient();
    if (!hub.exited) watchExit(hub, client);
    const listener: DataListener = (data, _incarnation, seq) => {
      hub.received = Math.max(hub.received, seq + data.length);
      hub.dirty = true;
      hub.pending.push({ seq, data });
      hub.pendingBytes += data.length;
      if (!hub.flushScheduled) {
        hub.flushScheduled = true;
        setImmediate(() => flushHub(hub));
      }
      // A turn already large enough is fed now rather than waiting: the batch stays bounded.
      if (hub.pendingBytes >= MAX_BATCH_BYTES) flushHub(hub);
    };
    hub.dataListener = listener;
    client.onData(hub.id, listener);
    try {
      const reply = await client.attach(hub.id, hub.received);
      // Record the ring's join. A truncated replay from a seeded screen is the gap policy's case;
      // the oldest byte can fall mid-escape, so this is a diagnostic/future-use fact, not part of
      // the resume.
      hub.ring = { oldestSeq: reply.oldestSeq, truncated: reply.truncated };
    } catch (error) {
      // Do not stay half-attached: a later connect retries this from the same offset.
      release(hub);
      throw error;
    }
  })();
  hub.attaching = promise;
  try {
    await promise;
  } finally {
    if (hub.attaching === promise) hub.attaching = undefined;
  }
};

/** Start a serve, catching a post-`finally` throw so it never becomes an unhandled rejection. */
const startServe = (hub: Hub, subscriber: Subscriber): void => {
  void serve(hub, subscriber).catch((error: unknown) => {
    logFailure(`serving ${hub.key} threw after its finally`, error);
    try {
      subscriber.onExit();
    } catch {
      // the page is already gone; the exit frame is best-effort
    }
  });
};

/** Serve one page: serialize the screen at the offset received so far, hold the bytes after it,
 * then hand the page the snapshot and every byte since. */
const serve = async (hub: Hub, subscriber: Subscriber): Promise<void> => {
  // Claim the hub synchronously: the guard and the claim are one step, so two attaches racing the
  // await below cannot both pass — the second would orphan the first's held bytes.
  hub.attachingPage = true;
  hub.unattendedSince = undefined;
  let queuedNext = false;
  try {
    // One live client per hub, newest wins. An established subscriber may be the previous socket
    // still closing — the page switched away and back before the server processed the close — so a
    // reattach supersedes it instead of being refused, which would strand the returning pane on an
    // `exit`. The superseded page is told the session is gone so it does not keep a stream it got no
    // snapshot for. A genuine second tab is not distinguishable from this at the hub, so it
    // supersedes too.
    const superseded = [...hub.subscribers];
    hub.subscribers.clear();
    for (const old of superseded) old.onExit();
    // The host attach is deferred to the first view for a reprintable hub; for every other screen it
    // is already attached (`ensureScreen`) and this is a no-op.
    await ensureAttached(hub);
    // The first view of a live agent forces a reprint; a dead or already-viewed hub does not.
    if (hub.reprintable && !hub.repainted && !hub.exited) {
      await repaintHub(hub);
      hub.repainted = true;
    }
    // Feed the current batch before holding anything: the cutoff below includes it, and a byte left
    // pending would go into `hold` (which is only applied after the snapshot) and deadlock
    // `whenApplied`. After this, only bytes that arrive later are held.
    flushHub(hub);
    const cutoff = hub.received;
    hub.hold = [];
    try {
      await hub.screen.whenApplied(cutoff);
      if (subscriber.cancelled || hub.disposed === true) {
        subscriber.onExit();
        return;
      }
      const { data, offset } = hub.screen.serialize();
      subscriber.snapshot({ data, offset });
      hub.subscribers.add(subscriber);
      // Consume the held bytes one at a time (shift, then write/send), so a `send` that throws
      // leaves the rest of `hold` for the finally to drain to the screen instead of losing them.
      while (hub.hold !== undefined && hub.hold.length > 0) {
        const chunk = hub.hold.shift()!;
        hub.screen.write(chunk.data, chunk.seq);
        if (!subscriber.cancelled) subscriber.send(chunk.data);
      }
    } finally {
      // Whatever was held but not delivered must still reach the screen: `hub.received` already
      // covers it, so a later `whenApplied(cutoff)` would otherwise wait forever — a dead hub with
      // an attach queue that never drains. The happy path shifted `hold` empty (or left only what a
      // throw skipped), so nothing is written twice.
      for (const chunk of hub.hold ?? []) hub.screen.write(chunk.data, chunk.seq);
      hub.hold = undefined;
    }
  } catch (error) {
    // A page this attach could not serve gets the exit, and the hub stays retryable. The attach
    // released the host listener on its own failure, so a later failure (serialize, send) must not
    // drop a healthy hub's listener.
    logFailure(`serving ${hub.key} failed`, error);
    hub.subscribers.delete(subscriber);
    subscriber.onExit();
  } finally {
    hub.attachingPage = false;
    // Restart the unattended clock unless a subscriber is attached (`noteAttendance` clears it when
    // one is): a serve that added nothing — or threw after adding — must not pin the screen.
    noteAttendance(hub);
    const queued = hub.queued;
    hub.queued = undefined;
    if (queued !== undefined) {
      if (hub.disposed !== true) {
        queuedNext = true;
        startServe(hub, queued);
      } else {
        queued.onExit();
      }
    }
  }
  // The session may have exited while the snapshot was serialized; its exit was deferred to here.
  if (!queuedNext && hub.exited) finish(hub);
};

/** Ask to serve a page. An attach already in flight (a first-view repaint can hold it for seconds)
 * queues the newcomer — newest wins — instead of answering with a final `exit`, which the page
 * would read as the session being gone. */
const subscribe = (hub: Hub, subscriber: Subscriber): void => {
  if (hub.disposed === true) {
    subscriber.onExit();
    return;
  }
  if (hub.attachingPage === true) {
    hub.queued?.onExit();
    hub.queued = subscriber;
    return;
  }
  startServe(hub, subscriber);
};

/** A host session the socket drives, with the identity its screen is keyed by. */
export type TerminalSession = {
  readonly sessionId: string;
  readonly incarnation: number;
  /** Start serving this page: the screen's snapshot, then live bytes. A second call is refused:
   * one hub serves one live client. */
  readonly attach: (
    send: (chunk: Uint8Array) => void,
    snapshot: (frame: { readonly data: string; readonly offset: number }) => void,
    onExit: () => void,
  ) => void;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: () => void;
};

/** What the socket upgrade carries: the session the route already started, at the size the page
 * asked for. Spawning before the upgrade is what lets a failure come back as an HTTP answer the
 * pane can show, instead of a socket that opens and then says nothing. */
export type TerminalSocket = { readonly session: TerminalSession };

/** The part of a server socket the terminal bridge uses, so the transport stays the app's. */
export type TerminalWebSocket = {
  readonly data: TerminalSocket;
  readonly send: (chunk: string | Uint8Array) => void;
  readonly close: () => void;
  /** Bytes queued on the socket but not yet flushed; the page is behind when this grows. Absent on
   * a test's fake socket. */
  readonly bufferedAmount?: number;
};

/** When this much output is queued undelivered, the page is behind. It is re-synced — closed so it
 * reconnects to a fresh snapshot — rather than buffered without bound, which is what keeps a slow
 * consumer from growing the server's memory and pinning it. */
const WS_BACKPRESSURE_BYTES = 1 << 20;
/** How long a fresh page may stay over the bound while its first snapshot drains. A large screen on
 * a slow link leaves the socket queued above the bound at attach, so closing immediately would
 * cycle reconnect-snapshot-reconnect; the grace **rate-limits** that cycle to one per grace rather
 * than removing it. Once the queue has been under the bound, or the grace passes, the steady-state
 * bound applies. A test can shorten it with `CORVI_BACKPRESSURE_GRACE_MS`. */
const WS_BACKPRESSURE_GRACE_MS = 5000;
const backpressureGraceMs = (): number =>
  envMs("CORVI_BACKPRESSURE_GRACE_MS", WS_BACKPRESSURE_GRACE_MS);

/** Create the server screen for a host window (idempotent) and start feeding it. Called when the
 * window is *opened*, not only when a page attaches: a window with no page (a subagent, a command)
 * captures its startup within the unattended grace, or for as long as the output fits the host's
 * 256 KiB ring, so a page attaching soon after misses nothing; a streaming session past the grace
 * falls to the gap policy (the stored screen plus the ring tail). The unattended release is what
 * drops a screen no page ever attaches to. */
export const ensureScreen = async (
  changeId: string,
  sessionId: string,
  incarnation: number,
  size: { readonly cols: number; readonly rows: number },
  origin: ScreenOrigin = plainOrigin,
): Promise<void> => {
  const client = await hostClient();
  const hub = hubFor(changeId, sessionId, incarnation, size, origin);
  // Opening or attaching restarts the unattended clock: the sweep must not release a screen that
  // is about to be looked at (between `openSession` and the socket's `subscribe`).
  noteAttendance(hub);
  hub.desiredCols = size.cols;
  hub.desiredRows = size.rows;
  hub.screen.resize(size.cols, size.rows);
  watchExit(hub, client);
  // A reprintable hub is attached (and jiggled) on first view, not here: an unwatched agent must
  // not pay for a full-view reprint. Every other screen is fed from the moment it opens, so its
  // startup is captured before the ring can evict it.
  if (!hub.reprintable) await ensureAttached(hub);
};

/** Start (or reuse) the change's active host window and hand back a session the socket drives.
 * Async so the route can start the host before upgrading. */
export const openSession = async (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number },
  paneSessionId?: string,
): Promise<TerminalSession> => {
  const unavailable = terminalUnavailable();
  if (unavailable !== undefined) throw new Error(unavailable);
  // `paneSessionId` names the pane the page wants to attach to; absent means the active window's
  // active pane. A stale id falls through to the active pane.
  const sessionId = await ensureActiveHostWindow(changeId, dir, size, paneSessionId);
  const client = await hostClient();
  // A window created before a page attached (a new tab, a subagent window) was opened at a
  // default size. Set the pty to the size the page actually has before anything is drawn into it,
  // or the shell wraps and backspaces on a grid the screen does not match.
  await client.resize(sessionId, size.cols, size.rows).catch(() => undefined);
  const entry = (await client.list()).find((candidate) => candidate.id === sessionId);
  const incarnation = entry?.incarnation ?? 0;
  // The session's own metadata classifies the screen: a subagent (`subagentId`) reprints itself,
  // and a dead one (a restored kept-open window) seeds from its frozen store entry.
  const subagentId = entry?.metadata?.subagentId?.trim();
  const origin: ScreenOrigin = {
    reprintable: subagentId !== undefined && subagentId !== "",
    dead: entry !== undefined && !entry.alive,
  };
  // Idempotent: the screen already exists for a window `windows.ts` opened (and is attached); it
  // is created here only for a window this route started itself.
  await ensureScreen(changeId, sessionId, incarnation, size, origin);
  const hub = hubFor(changeId, sessionId, incarnation, size, origin);
  let subscriber: Subscriber | undefined;
  return {
    sessionId,
    incarnation: hub.incarnation,
    attach: (send, snapshot, onExit) => {
      if (subscriber !== undefined) return; // one live client per session (module comment)
      subscriber = { send, snapshot, onExit, cancelled: false };
      subscribe(hub, subscriber);
    },
    write: (data) => {
      void client.write(sessionId, data);
    },
    resize: (cols, rows) => {
      hub.desiredCols = cols;
      hub.desiredRows = rows;
      void client.resize(sessionId, cols, rows);
      hub.screen.resize(cols, rows);
    },
    kill: () => {
      if (subscriber === undefined) return;
      // The page may leave before its attach finished (a first-view repaint can hold it for
      // seconds): mark it cancelled so `serve` drops it instead of adding a ghost subscriber that
      // pins the screen and parses forever.
      subscriber.cancelled = true;
      hub.subscribers.delete(subscriber);
      if (hub.queued === subscriber) hub.queued = undefined;
      subscriber = undefined;
      // The last page leaving leaves the screen and the host listener: the screen belongs to the
      // session, not to the page. The sweep releases it after the unattended grace, which is what
      // stops an unwatched screen from being parsed forever.
      noteAttendance(hub);
    },
  };
};

/** Drop every hub and screen. The host and its shells live on; the tests reset with this. */
export const closeAttachments = (): void => {
  for (const hub of hubs.values()) {
    release(hub);
    watchExitOff(hub);
    hub.subscribers.clear();
    hub.disposed = true;
    hub.screen.dispose();
  }
  hubs.clear();
};

/** Attachment counts, for the tests that pin one-attach and no-listener-leak. */
export const hubStats = (): { hubs: number; attached: number; subscribers: number } => {
  let attached = 0;
  let subscribers = 0;
  for (const hub of hubs.values()) {
    if (hub.dataListener !== undefined) attached++;
    subscribers += hub.subscribers.size;
  }
  return { hubs: hubs.size, attached, subscribers };
};

/** The grid a live hub's screen is at, for the tests that pin the repaint's size handling. */
export const hubGrid = (
  sessionId: string,
  incarnation: number,
): { readonly cols: number; readonly rows: number } | undefined => {
  const hub = hubs.get(`${sessionId}#${incarnation}`);
  return hub === undefined ? undefined : { cols: hub.screen.cols, rows: hub.screen.rows };
};

/** Test seam: report host bytes without feeding the screen, so a test can open a serve's window at
 * a cutoff the screen has not reached. */
export const setReceivedForTest = (sessionId: string, incarnation: number, seq: number): void => {
  const hub = hubs.get(`${sessionId}#${incarnation}`);
  if (hub !== undefined) hub.received = Math.max(hub.received, seq);
};

/** Test seam: push a chunk into a serve's hold (the post-cutoff window). Returns false when no serve
 * is holding, so a test can poll for the window. */
export const holdChunkForTest = (sessionId: string, incarnation: number, seq: number, data: string): boolean => {
  const hub = hubs.get(`${sessionId}#${incarnation}`);
  if (hub === undefined || hub.hold === undefined || hub.disposed === true) return false;
  hub.hold.push({ seq, data: Buffer.from(data) });
  hub.received = Math.max(hub.received, seq + data.length);
  return true;
};

/** Test seam: let the screen reach a serve's cutoff (the bytes the host produced before the hold
 * began), so the serve proceeds and the hold window closes. */
export const applyCutoffForTest = (sessionId: string, incarnation: number, seq: number, data: string): void => {
  const hub = hubs.get(`${sessionId}#${incarnation}`);
  if (hub === undefined) return;
  hub.screen.write(Buffer.from(data), seq);
  hub.received = Math.max(hub.received, seq + data.length);
};

/** The control frames the page sends, parsed once. */
type PageControl = { readonly type: "resize"; readonly cols: number; readonly rows: number };

const pageControl = (message: string): PageControl | undefined => {
  try {
    const value = JSON.parse(message) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (value.type === "resize" && typeof value.cols === "number" && typeof value.rows === "number") {
      return { type: "resize", cols: Math.max(1, Math.floor(value.cols)), rows: Math.max(1, Math.floor(value.rows)) };
    }
  } catch {
    // not a control frame: ignored
  }
  return undefined;
};

/** The WebSocket handlers `server.ts` installs. */
export const terminalSockets = {
  /** Serve the page: the screen's snapshot first (or `reset` when it is empty), then live bytes.
   * The page sends nothing to start; the server owns the offset. */
  open(ws: TerminalWebSocket): void {
    const { session } = ws.data;
    const openedAt = Date.now();
    let drained = false;
    session.attach(
      (chunk) => {
        const queued = ws.bufferedAmount ?? 0;
        if (!drained && (queued <= WS_BACKPRESSURE_BYTES || Date.now() - openedAt >= backpressureGraceMs())) {
          drained = true;
        }
        // A page that cannot keep up is re-synced from the screen rather than buffered without
        // bound: close it (no `exit`) and its reconnect gets a fresh snapshot.
        if (drained && queued > WS_BACKPRESSURE_BYTES) {
          ws.close();
          return;
        }
        ws.send(chunk);
      },
      ({ data }) => {
        if (data === "") {
          ws.send(JSON.stringify({ type: "reset", incarnation: session.incarnation, sessionId: session.sessionId }));
          return;
        }
        ws.send(JSON.stringify({ type: "snapshot", data, incarnation: session.incarnation, sessionId: session.sessionId }));
      },
      () => {
        // The session is gone: tell the page so it does not reconnect into a new shell, then
        // close. An abnormal close (the server died) carries no frame and the page retries.
        try {
          ws.send(JSON.stringify({ type: "exit" }));
        } catch {
          // the socket is already closing
        }
        ws.close();
      },
    );
  },
  message(ws: TerminalWebSocket, message: string | Uint8Array): void {
    if (typeof message === "string") {
      const control = pageControl(message);
      if (control === undefined) return;
      ws.data.session.resize(control.cols, control.rows);
      return;
    }
    ws.data.session.write(new TextDecoder().decode(message));
  },
  close(ws: TerminalWebSocket): void {
    ws.data.session.kill();
  },
};
