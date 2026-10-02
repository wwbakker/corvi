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
 * The socket protocol, chosen so neither direction can be mistaken for the other:
 *
 *   - page to server: binary is what you typed; text is JSON control (`resize`);
 *   - server to page: binary is terminal output; text is JSON control (`snapshot` with the
 *     serialized screen and its `highWater` offset, `reset` when the screen is empty, `exit` when
 *     the session is gone and no reconnect should follow).
 */
import type { HostClient } from "../host/client.ts";
import { hostClient } from "./host.ts";
import { makeScreen, type Screen } from "./screen.ts";
import { ensureActiveHostWindow } from "./windows.ts";

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
  /** While a page is attaching: the offset captured, and the bytes after it, held until the
   * snapshot is sent and the subscriber registered. */
  hold?: { readonly cutoff: number; readonly chunks: Held[] };
  /** An attach is in its serialize/register window; the session's exit waits for it to finish. */
  attachingPage?: boolean;
};

const hubs = new Map<string, Hub>();

/** Get-or-create synchronously: two concurrent opens of one incarnation cannot each make a hub. */
const hubFor = (id: string, incarnation: number, size: { readonly cols: number; readonly rows: number }): Hub => {
  const key = `${id}#${incarnation}`;
  const existing = hubs.get(key);
  if (existing !== undefined) return existing;
  const hub: Hub = {
    key,
    id,
    incarnation,
    screen: makeScreen(size),
    subscribers: new Set(),
    received: 0,
    exited: false,
  };
  hubs.set(key, hub);
  return hub;
};

/** Tell the hub's live client the session is gone, dispose the screen, and forget the hub. */
const finish = (hub: Hub): void => {
  const subscribers = [...hub.subscribers];
  hub.subscribers.clear();
  release(hub);
  hub.screen.dispose();
  hubs.delete(hub.key);
  for (const subscriber of subscribers) subscriber.onExit();
};

/** The exit of a session ends the hub whenever it happens, page or no page. An attach that is
 * serializing the last screen is allowed to finish first, so it serves what the session left. */
const onSessionExit = (hub: Hub) => (): void => {
  if (hub.exited) return;
  hub.exited = true;
  watchExitOff(hub);
  // An attach may be serializing the last screen; it finishes the hub after it serves that. A
  // session that exits with no page attached keeps its screen — it is the session's history, and
  // a page may still attach — until P2's eviction (or the tests' reset) drops it.
  if (hub.attachingPage) return;
  if (hub.subscribers.size === 0) return;
  if (hub.attaching !== undefined) void hub.attaching.then(() => finish(hub), () => finish(hub));
  else finish(hub);
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
 * the ring still holds; the first chunk's `seq` anchors the screen's offset. */
const ensureAttached = async (hub: Hub): Promise<void> => {
  if (hub.dataListener !== undefined) return;
  if (hub.attaching !== undefined) return hub.attaching;
  const promise = (async (): Promise<void> => {
    const client = await hostClient();
    if (!hub.exited) watchExit(hub, client);
    const listener: DataListener = (data, _incarnation, seq) => {
      hub.received = Math.max(hub.received, seq + data.length);
      if (hub.hold !== undefined) {
        hub.hold.chunks.push({ seq, data });
        return;
      }
      hub.screen.write(data, seq);
      for (const subscriber of hub.subscribers) subscriber.send(data);
    };
    hub.dataListener = listener;
    client.onData(hub.id, listener);
    await client.attach(hub.id, hub.received);
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
  // One live client per hub, as before: a second attach is answered with the exit rather than
  // silently fanned out into a stream it did not get a snapshot for.
  if (hub.subscribers.size > 0) {
    subscriber.onExit();
    return;
  }
  const cutoff = hub.received;
  hub.hold = { cutoff, chunks: [] };
  hub.attachingPage = true;
  try {
    await hub.screen.whenApplied(cutoff);
    const { data, offset } = hub.screen.serialize();
    subscriber.snapshot({ data, offset });
    hub.subscribers.add(subscriber);
    const chunks = hub.hold?.chunks ?? [];
    hub.hold = undefined;
    for (const chunk of chunks) {
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

/** Start (or reuse) the change's active host window and hand back a session the socket drives.
 * Async so the route can start the host before upgrading. */
export const openSession = async (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number },
  windowId?: string,
): Promise<TerminalSession> => {
  const unavailable = terminalUnavailable();
  if (unavailable !== undefined) throw new Error(unavailable);
  const sessionId = await ensureActiveHostWindow(changeId, dir, size, windowId);
  const client = await hostClient();
  // A window created before a page attached (a new tab, a subagent window) was opened at a
  // default size. Set the pty to the size the page actually has before anything is drawn into it,
  // or the shell wraps and backspaces on a grid the screen does not match.
  await client.resize(sessionId, size.cols, size.rows).catch(() => undefined);
  const incarnation = (await client.list()).find((entry) => entry.id === sessionId)?.incarnation ?? 0;
  const hub = hubFor(sessionId, incarnation, size);
  // The screen is the page's grid too. The pty was just resized; an existing screen follows.
  hub.screen.resize(size.cols, size.rows);
  watchExit(hub, client);
  // The screen exists from here on, so the host listener stays: it is fed with no page attached,
  // which is what makes returning to a busy window exact. Wait for the attach, so the first
  // snapshot already carries the ring and a dead kept-open session still has its output.
  await ensureAttached(hub).catch(() => undefined);
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
      // The last page leaving leaves the screen and the host listener: the screen belongs to the
      // session, not to the page.
    },
  };
};

/** Drop every hub and screen. The host and its shells live on; the tests reset with this. */
export const closeAttachments = (): void => {
  for (const hub of hubs.values()) {
    release(hub);
    watchExitOff(hub);
    hub.subscribers.clear();
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
      ({ data, offset }) => {
        if (data === "") {
          ws.send(JSON.stringify({ type: "reset", since: 0, incarnation: session.incarnation, sessionId: session.sessionId }));
          return;
        }
        ws.send(
          JSON.stringify({
            type: "snapshot",
            data,
            highWater: offset,
            incarnation: session.incarnation,
            sessionId: session.sessionId,
          }),
        );
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
