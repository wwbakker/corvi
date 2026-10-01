/**
 * The WebSocket's terminal half: one host subscription per session incarnation, fanned out to the
 * page.
 *
 * The host owns the pty and its replay ring; this process only relays. A hub exists per
 * `(sessionId, incarnation)`, attaches to the host exactly once while at least one socket is
 * attached, and releases its host data listener when the last one detaches. The host's
 * `attach since` replays what was missed, so the hub keeps no output of its own — the flagship
 * "shell keeps running" case cannot grow a buffer here. `kill()` means detach, never kill: closing
 * a page leaves the shell running.
 *
 * One hub serves one live client. That is the page's model (one terminal, one xterm), and it is
 * why a second `attach` on the same session is refused rather than fanning out: a subscriber that
 * joins an already-attached hub would receive future bytes only, silently missing the snapshot's
 * gap. Multi-client is a server-owned-screen slice's problem, not this one's.
 *
 * The socket protocol, chosen so neither direction can be mistaken for the other:
 *
 *   - page to server: binary is what you typed; text is JSON control
 *     (`attach` with `since`, `snapshot` with `data`/`highWater`, `resize`);
 *   - server to page: binary is terminal output; text is JSON control
 *     (`snapshot` on connect, `reset` when there is none, `truncated` when the host's ring evicted
 *     past the requested offset, `exit` when the session is gone and no reconnect should follow).
 *
 * The server sends the control frame first, on connect: a stored snapshot to replay, or `reset`
 * for a fresh terminal. The page replays it and only then sends `attach`, so the bytes from the
 * host never race the snapshot they resume from.
 */
import type { HostClient } from "../host/client.ts";
import { hostClient } from "./host.ts";
import { snapshotOf, setSnapshot } from "./snapshots.ts";
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
  /** The host evicted past the page's snapshot: discard it and treat `since` as the new base. */
  readonly reset: (since: number) => void;
  readonly onExit: () => void;
};

type DataListener = (data: Buffer, incarnation: number, seq: number) => void;
type ExitListener = (exitCode: number, signal: number, incarnation: number) => void;

type Hub = {
  /** `sessionId#incarnation`: a reused session id gets a fresh hub with its own offset. */
  readonly key: string;
  readonly id: string;
  incarnation: number;
  readonly subscribers: Set<Subscriber>;
  /** The highest byte offset forwarded, so a re-attach resumes from there instead of replaying. */
  lastSeq: number;
  exited: boolean;
  /** Registered while a socket is attached; removed on the last detach. */
  dataListener?: DataListener;
  /** Registered at open and kept until the session exits, so a session that dies while detached
   * is still cleaned up rather than dangling forever. */
  exitListener?: ExitListener;
  /** The client the listeners belong to, for removal. */
  client?: HostClient;
  attaching?: Promise<void>;
  /** While the initial attach is in flight, output is held here so a truncated replay can be
   * preceded by a `truncated` control frame instead of interleaved with it. */
  pendingReplay?: Uint8Array[];
};

const hubs = new Map<string, Hub>();

/** Get-or-create synchronously: two concurrent opens of one incarnation cannot each make a hub. */
const hubFor = (id: string, incarnation: number): Hub => {
  const key = `${id}#${incarnation}`;
  const existing = hubs.get(key);
  if (existing !== undefined) return existing;
  const hub: Hub = { key, id, incarnation, subscribers: new Set(), lastSeq: 0, exited: false };
  hubs.set(key, hub);
  return hub;
};

/** The exit of a session is the hub's and the snapshot's cue, whether or not a socket is attached:
 * a session that exits while detached must not leave a hub or a persisted snapshot behind. The
 * snapshot is not forgotten here — the windows layer knows which records asked to be kept open,
 * and keeps theirs. */
const onSessionExit = (hub: Hub) => (): void => {
  if (hub.exited) return;
  hub.exited = true;
  release(hub);
  watchExitOff(hub);
  for (const subscriber of hub.subscribers) subscriber.onExit();
  hubs.delete(hub.key);
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

/** Remove the data listener so a detached hub stops receiving bytes. The exit listener stays. */
const release = (hub: Hub): void => {
  if (hub.client !== undefined && hub.dataListener !== undefined) {
    hub.client.offData(hub.id, hub.dataListener);
  }
  hub.dataListener = undefined;
};

/** Attach to the host once per hub, from the hub's current offset. A truncated replay is
 * announced with a `reset` control frame before the bytes so the page can discard the snapshot
 * it can no longer continue from. */
const ensureAttached = async (hub: Hub): Promise<void> => {
  if (hub.exited || hub.dataListener !== undefined) return;
  if (hub.attaching !== undefined) return hub.attaching;
  const promise = (async (): Promise<void> => {
    const client = await hostClient();
    watchExit(hub, client);
    const dataListener: DataListener = (data, _incarnation, seq) => {
      hub.lastSeq = Math.max(hub.lastSeq, seq + data.length);
      if (hub.pendingReplay !== undefined) hub.pendingReplay.push(data);
      else for (const subscriber of hub.subscribers) subscriber.send(data);
    };
    hub.dataListener = dataListener;
    client.onData(hub.id, dataListener);
    hub.pendingReplay = [];
    try {
      const reply = await client.attach(hub.id, hub.lastSeq);
      hub.incarnation = reply.incarnation;
      const replay = hub.pendingReplay;
      hub.pendingReplay = undefined;
      if (reply.truncated) {
        // The ring evicted past the requested offset: the replay starts at `oldestSeq`, so the
        // page's snapshot (and everything before `oldestSeq`) is gone. Reset to that new base;
        // `lastSeq` only moves forward, since the buffered replay already advanced it.
        hub.lastSeq = Math.max(hub.lastSeq, reply.oldestSeq);
        for (const subscriber of hub.subscribers) subscriber.reset(reply.oldestSeq);
      }
      for (const data of replay ?? []) for (const subscriber of hub.subscribers) subscriber.send(data);
    } catch (error) {
      hub.pendingReplay = undefined;
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

const subscribe = async (hub: Hub, subscriber: Subscriber, since: number): Promise<void> => {
  if (hub.exited) {
    subscriber.onExit();
    return;
  }
  hub.subscribers.add(subscriber);
  // A fresh subscription resumes from where its snapshot ended; the host replays from there. With
  // a hub already attached (a second page), only future bytes would reach the new subscriber,
  // which is why the session refuses a second attach (see the module comment).
  if (hub.dataListener === undefined && hub.attaching === undefined) hub.lastSeq = Math.max(0, since);
  await ensureAttached(hub);
  if (hub.exited) subscriber.onExit();
};

/** A host session the socket drives, with the identity its snapshot is keyed by. */
export type TerminalSession = {
  readonly sessionId: string;
  readonly incarnation: number;
  /** Start delivering output to this subscriber, resuming the host at `since`. A second call on
   * the same session is refused: one hub serves one live client. */
  readonly attach: (
    send: (chunk: Uint8Array) => void,
    reset: (since: number) => void,
    onExit: () => void,
    since: number,
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
  const incarnation = (await client.list()).find((entry) => entry.id === sessionId)?.incarnation ?? 0;
  const hub = hubFor(sessionId, incarnation);
  // Watch the exit from the moment the session is opened, not only while a socket is attached: a
  // detached session that exits must still clear its hub.
  watchExit(hub, client);
  let subscriber: Subscriber | undefined;
  return {
    sessionId,
    incarnation,
    attach: (send, reset, onExit, since) => {
      if (subscriber !== undefined) return; // one live client per session (module comment)
      subscriber = { send, reset, onExit };
      void subscribe(hub, subscriber, since).catch(() => subscriber?.onExit());
    },
    write: (data) => {
      void client.write(sessionId, data);
    },
    resize: (cols, rows) => {
      void client.resize(sessionId, cols, rows);
    },
    kill: () => {
      if (subscriber === undefined) return;
      hub.subscribers.delete(subscriber);
      subscriber = undefined;
      // The last socket leaving releases the host data listener; the shell keeps running and the
      // next attach resumes through the host's replay. The exit watcher stays.
      if (hub.subscribers.size === 0 && !hub.exited) release(hub);
    },
  };
};

/** Drop every attachment. The host and its shells live on. */
export const closeAttachments = (): void => {
  for (const hub of hubs.values()) {
    release(hub);
    watchExitOff(hub);
    hub.subscribers.clear();
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
type PageControl =
  | { readonly type: "attach"; readonly since: number }
  | { readonly type: "snapshot"; readonly data: string; readonly highWater: number }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };

const pageControl = (message: string): PageControl | undefined => {
  try {
    const value = JSON.parse(message) as { type?: unknown; since?: unknown; data?: unknown; highWater?: unknown; cols?: unknown; rows?: unknown };
    if (value.type === "attach" && typeof value.since === "number") {
      return { type: "attach", since: Math.max(0, Math.floor(value.since)) };
    }
    if (value.type === "snapshot" && typeof value.data === "string" && typeof value.highWater === "number") {
      return { type: "snapshot", data: value.data, highWater: value.highWater };
    }
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
  /** Send the control frame first: the stored snapshot to replay, or `reset` for a fresh screen.
   * The page answers with `attach` once it has played the frame back. */
  open(ws: TerminalWebSocket): void {
    const { session } = ws.data;
    const snapshot = snapshotOf(session.sessionId, session.incarnation);
    if (snapshot === undefined) {
      ws.send(JSON.stringify({ type: "reset", since: 0, incarnation: session.incarnation }));
      return;
    }
    ws.send(
      JSON.stringify({
        type: "snapshot",
        data: snapshot.data,
        highWater: snapshot.highWater,
        incarnation: session.incarnation,
      }),
    );
  },
  message(ws: TerminalWebSocket, message: string | Uint8Array): void {
    if (typeof message === "string") {
      const control = pageControl(message);
      if (control === undefined) return;
      const { session } = ws.data;
      if (control.type === "attach") {
        session.attach(
          (chunk) => ws.send(chunk),
          (since) => ws.send(JSON.stringify({ type: "truncated", since, incarnation: session.incarnation })),
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
          control.since,
        );
      } else if (control.type === "snapshot") {
        setSnapshot(session.sessionId, session.incarnation, control.data, control.highWater);
      } else {
        session.resize(control.cols, control.rows);
      }
      return;
    }
    ws.data.session.write(new TextDecoder().decode(message));
  },
  close(ws: TerminalWebSocket): void {
    ws.data.session.kill();
  },
};
