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
 * synchronously on a controlled shutdown. A screen with no page and no output for a timeout is
 * released — the store keeps it, so a later attach still resumes, and the server drops its host
 * attachment. (The host's own idle timeout is disabled while the server holds its connection, so
 * this release is what frees the host's interest; the host idles once the server exits.) On
 * creation a screen is seeded from the store and the host attaches from the stored offset; see
 * `hubFor` for the gap policy and its visible cost. "Exact" here is screen-content exact: the
 * serializer restores the text and the modes it knows, not every parser state, and the stored
 * offset can fall mid-escape.
 *
 * The socket protocol, chosen so neither direction can be mistaken for the other:
 *
 *   - page to server: binary is what you typed; text is JSON control (`resize`);
 *   - server to page: binary is terminal output; text is JSON control (`snapshot` with the
 *     serialized screen, `reset` when the screen is empty, `exit` when the session is gone and no
 *     reconnect should follow).
 */
import type { HostClient } from "../host/client.ts";
import { hostClient } from "./host.ts";
import { makeScreen, type Screen, type ScreenSnapshot } from "./screen.ts";
import { SNAPSHOT_MAX_BYTES, forgetSnapshot, setSnapshots, snapshotOf, type SnapshotInput } from "./snapshots.ts";
import { ensureActiveHostWindow, isKeptOpen } from "./windows.ts";

/** How often a dirty screen is written to the store. Serializing a 5,000-row screen is ~17 ms and
 * only dirty screens are serialized, so a busy session costs at most one such write per cadence
 * and a quiet one costs nothing. The shutdown flush makes the last moments exact regardless. A
 * test can shorten it with `CORVI_SCREEN_CADENCE_MS`. */
const SNAPSHOT_CADENCE_MS = 5000;
/** A screen with no page and no output for this long is released: the store keeps it for a later
 * attach, and the host is left holding nothing. A test can shorten it with `CORVI_SCREEN_IDLE_MS`. */
const SCREEN_IDLE_MS = 5 * 60_000;
/** The lifecycle sweep's tick: it decides whether each screen is due to persist or to be released.
 * Cheap (it iterates hubs), so the cadence and timeout can be read per tick. */
const SWEEP_TICK_MS = 250;

const cadenceMs = (): number => Number(process.env.CORVI_SCREEN_CADENCE_MS) || SNAPSHOT_CADENCE_MS;
const idleMs = (): number => Number(process.env.CORVI_SCREEN_IDLE_MS) || SCREEN_IDLE_MS;

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
};

type DataListener = (data: Buffer, incarnation: number, seq: number) => void;
type ExitListener = (exitCode: number, signal: number, incarnation: number) => void;

/** A host chunk held while a page attach serializes. */
type Held = { readonly seq: number; readonly data: Buffer };

type Hub = {
  /** `sessionId#incarnation`: a reused session id gets a fresh hub and screen. */
  readonly key: string;
  /** The change the window belongs to, for the keep-open check on exit. */
  readonly changeId: string;
  readonly id: string;
  incarnation: number;
  readonly screen: Screen;
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
  /** The screen changed since it was last written to the store. */
  dirty: boolean;
  /** When the screen last saw a byte or a page, for the idle release. */
  lastActivity: number;
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
): Hub => {
  const key = `${id}#${incarnation}`;
  const existing = hubs.get(key);
  if (existing !== undefined) return existing;
  const hub: Hub = {
    key,
    changeId,
    id,
    incarnation,
    screen: makeScreen(size),
    subscribers: new Set(),
    received: 0,
    exited: false,
    dirty: false,
    lastActivity: Date.now(),
    lastPersist: 0,
  };
  // Seed the screen from the store when one exists for this exact incarnation. The host then
  // attaches from `received` (the stored offset), so one server's resume is exact — with the
  // caveats in the module and `screen.ts` docs: "exact" is the screen content the serializer can
  // restore (text and the modes it knows, not every parser state, and the stored offset can fall
  // mid-escape). Gap policy: when the host's ring has already evicted past the stored offset,
  // there is a hole between it and the ring's oldest byte. We keep the deep screen and let the
  // ring's incremental bytes land on top of it rather than rebuild — the store exists for deep
  // history, and rebuilding would forfeit it. The visible cost is that those incremental bytes
  // address a screen state from an older offset, so a TUI that never fully redraws can look
  // scrambled until its next paint; the hole is bounded by the 256 KiB ring, not by the missing
  // span. `screen.write`'s monotonic offset keeps the ring's older seqs from pulling the stored
  // high-water back.
  const stored = snapshotOf(id, incarnation);
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

/** Mark screens stored: `dirty` clears only after the write succeeded. */
const markStored = (entries: readonly { readonly hub: Hub }[], at: number): void => {
  for (const { hub } of entries) {
    hub.dirty = false;
    hub.lastPersist = at;
  }
};

/** Write one dirty screen (exit, idle release). */
const persistScreen = (hub: Hub): void => {
  const result = screenSnapshot(hub);
  if (result === undefined) return;
  if (result === "empty") {
    forgetSnapshot(hub.id, hub.incarnation);
    hub.dirty = false;
    return;
  }
  setSnapshots([result]);
  markStored([{ hub }], Date.now());
};

/** Write every dirty screen in one pass, for the controlled shutdown. Synchronous on purpose: a
 * signal handler has no time to await, and the store persists with a rename. */
export const flushScreens = (): void => {
  const due: { hub: Hub; input: SnapshotInput }[] = [];
  const empty: Hub[] = [];
  for (const hub of hubs.values()) {
    const result = screenSnapshot(hub);
    if (result === "empty") empty.push(hub);
    else if (result !== undefined) due.push({ hub, input: result });
  }
  if (due.length > 0) {
    setSnapshots(due.map((entry) => entry.input));
    markStored(due, Date.now());
  }
  for (const hub of empty) {
    forgetSnapshot(hub.id, hub.incarnation);
    hub.dirty = false;
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
  const idle = idleMs();
  const due: { hub: Hub; input: SnapshotInput }[] = [];
  const empty: Hub[] = [];
  const releasing: Hub[] = [];
  for (const hub of [...hubs.values()]) {
    if (hub.attachingPage) continue; // an in-flight attach owns the screen right now
    const dueForCadence = hub.dirty && now - hub.lastPersist >= cadence;
    const idleNow = hub.subscribers.size === 0 && now - hub.lastActivity >= idle;
    if (!dueForCadence && !idleNow) continue;
    const result = screenSnapshot(hub); // persist before releasing, so nothing is lost
    if (result === "empty") empty.push(hub);
    else if (result !== undefined) due.push({ hub, input: result });
    if (idleNow) releasing.push(hub);
  }
  if (due.length > 0) {
    setSnapshots(due.map((entry) => entry.input));
    markStored(due, now);
  }
  for (const hub of empty) {
    forgetSnapshot(hub.id, hub.incarnation);
    hub.dirty = false;
  }
  for (const hub of releasing) releaseScreen(hub);
};

// The sweep is the only timer the module owns; it must not keep a test process alive.
setInterval(sweep, SWEEP_TICK_MS).unref();

/** Tell the hub's live client the session is gone and forget the hub — unless the window asked to
 * be kept open, whose frozen screen stays for a later look. */
const finish = (hub: Hub): void => {
  const subscribers = [...hub.subscribers];
  hub.subscribers.clear();
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
  // The session's last screen is worth keeping before the hub lets go: a kept-open window's frozen
  // output survives a restart through it.
  persistScreen(hub);
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
  if (!isKeptOpen(hub.changeId, hub.id)) {
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
      hub.lastActivity = Date.now();
      hub.dirty = true;
      if (hub.hold !== undefined) {
        hub.hold.push({ seq, data });
        return;
      }
      hub.screen.write(data, seq);
      for (const subscriber of hub.subscribers) subscriber.send(data);
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

/** Serve one page: serialize the screen at the offset received so far, hold the bytes after it,
 * then hand the page the snapshot and every byte since. */
const subscribe = async (hub: Hub, subscriber: Subscriber): Promise<void> => {
  // Claim the hub synchronously: the guard and the claim are one step, so two attaches racing the
  // await below cannot both pass — the second would orphan the first's held bytes. A second
  // attach — a second socket, or a second `openSession` — is answered with the exit.
  if (hub.disposed === true || hub.subscribers.size > 0 || hub.attachingPage === true) {
    subscriber.onExit();
    return;
  }
  hub.attachingPage = true;
  hub.lastActivity = Date.now();
  const cutoff = hub.received;
  hub.hold = [];
  try {
    await hub.screen.whenApplied(cutoff);
    const { data, offset } = hub.screen.serialize();
    subscriber.snapshot({ data, offset });
    hub.subscribers.add(subscriber);
    const held = hub.hold;
    hub.hold = undefined;
    for (const chunk of held) {
      hub.screen.write(chunk.data, chunk.seq);
      subscriber.send(chunk.data);
    }
  } finally {
    hub.hold = undefined;
    hub.attachingPage = false;
  }
  // The session may have exited while the snapshot was serialized; its exit was deferred to here.
  if (hub.exited) finish(hub);
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
};

/** Create the server screen for a host window (idempotent) and start feeding it. Called when the
 * window is *opened*, not only when a page attaches: a window with no page (a subagent, a command)
 * must capture its startup before the host's ring can evict it, or a page attaching later would
 * miss the base. The idle release is what drops a screen no page ever attaches to. */
export const ensureScreen = async (
  changeId: string,
  sessionId: string,
  incarnation: number,
  size: { readonly cols: number; readonly rows: number },
): Promise<void> => {
  const client = await hostClient();
  const hub = hubFor(changeId, sessionId, incarnation, size);
  hub.lastActivity = Date.now();
  hub.screen.resize(size.cols, size.rows);
  watchExit(hub, client);
  await ensureAttached(hub);
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
  const sessionId = await ensureActiveHostWindow(changeId, dir, size, undefined, paneSessionId);
  const client = await hostClient();
  // A window created before a page attached (a new tab, a subagent window) was opened at a
  // default size. Set the pty to the size the page actually has before anything is drawn into it,
  // or the shell wraps and backspaces on a grid the screen does not match.
  await client.resize(sessionId, size.cols, size.rows).catch(() => undefined);
  const incarnation = (await client.list()).find((entry) => entry.id === sessionId)?.incarnation ?? 0;
  // Idempotent: the screen already exists for a window `windows.ts` opened (and is attached); it
  // is created here only for a window this route started itself.
  await ensureScreen(changeId, sessionId, incarnation, size);
  const hub = hubFor(changeId, sessionId, incarnation, size);
  let subscriber: Subscriber | undefined;
  return {
    sessionId,
    incarnation: hub.incarnation,
    attach: (send, snapshot, onExit) => {
      if (subscriber !== undefined) return; // one live client per session (module comment)
      subscriber = { send, snapshot, onExit };
      void subscribe(hub, subscriber).catch(() => subscriber?.onExit());
    },
    write: (data) => {
      void client.write(sessionId, data);
    },
    resize: (cols, rows) => {
      void client.resize(sessionId, cols, rows);
      hub.screen.resize(cols, rows);
    },
    kill: () => {
      if (subscriber === undefined) return;
      hub.subscribers.delete(subscriber);
      subscriber = undefined;
      hub.lastActivity = Date.now();
      // The last page leaving leaves the screen and the host listener: the screen belongs to the
      // session, not to the page. The idle sweep releases it only after a quiet timeout.
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
    session.attach(
      (chunk) => ws.send(chunk),
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
