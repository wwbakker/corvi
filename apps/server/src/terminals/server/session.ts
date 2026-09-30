/**
 * The WebSocket's terminal half: one host subscription per session incarnation, fanned out to the
 * page.
 *
 * The host owns the pty and its replay buffer; this process only relays. A hub exists per
 * `(sessionId, incarnation)`, attaches to the host exactly once while at least one socket is
 * attached, and releases its host listeners when the last one detaches. The host's `attach since`
 * replays what was missed, so the hub keeps no output of its own — the flagship "shell keeps
 * running" case cannot grow a buffer here. `kill()` means detach, never kill: closing a page
 * leaves the shell running.
 */
import type { HostClient } from "../host/client.ts";
import type { TerminalSession, TerminalSocket, TerminalWebSocket } from "@corvi/terminals/session";
import { hostClient } from "./host.ts";
import { ensureActiveHostWindow } from "./windows.ts";

export type { TerminalSession, TerminalSocket } from "@corvi/terminals/session";

const onBun = (process.versions as Record<string, string | undefined>).bun !== undefined;

/** Why a terminal cannot start here, if it cannot. The route asks first, so the pane shows the
 * reason instead of opening a socket that never speaks. A server on Bun with a Node host runtime
 * (`CORVI_HOST_RUNTIME`, the tests' seam) is fine: the pty is delivered by the Node host. */
export const terminalUnavailable = (): string | undefined =>
  onBun && process.env.CORVI_HOST_RUNTIME === undefined
    ? "the terminal needs Node — Bun never delivers pty output; run the server with Node (`bun run dev` does)"
    : undefined;

/** Sent before a replay that starts past the client's last offset: the screen's earlier bytes are
 * gone, so clear it rather than draw the new stream over corrupt state. Slice 3's snapshots own
 * the fuller resume. */
const RESET = "\x1b[2J\x1b[3J\x1b[H";

type Subscriber = { readonly send: (chunk: string) => void; readonly onExit: () => void };

type Listener = {
  readonly data: (data: Buffer, incarnation: number, seq: number) => void;
  readonly exit: (exitCode: number, signal: number, incarnation: number) => void;
};

type Hub = {
  /** `sessionId#incarnation`: a reused session id gets a fresh hub with its own offset. */
  readonly key: string;
  readonly id: string;
  incarnation: number;
  readonly subscribers: Set<Subscriber>;
  /** The highest byte offset forwarded, so a re-attach resumes from there instead of replaying. */
  lastSeq: number;
  exited: boolean;
  listener?: Listener;
  attaching?: Promise<void>;
  client?: HostClient;
  /** While the initial attach is in flight, output is held here so a truncated replay can be
   * preceded by a reset instead of interleaved with it. */
  pendingReplay?: string[];
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

const release = (hub: Hub): void => {
  const client = hub.client;
  const listener = hub.listener;
  if (client !== undefined && listener !== undefined) {
    client.offData(hub.id, listener.data);
    client.offExit(hub.id, listener.exit);
  }
  hub.listener = undefined;
};

/** Attach to the host once per hub, from the last forwarded offset. */
const ensureAttached = async (hub: Hub): Promise<void> => {
  if (hub.exited || hub.listener !== undefined) return;
  if (hub.attaching !== undefined) return hub.attaching;
  const promise = (async (): Promise<void> => {
    const client = await hostClient();
    hub.client = client;
    const listener: Listener = {
      data: (data, _incarnation, seq) => {
        hub.lastSeq = Math.max(hub.lastSeq, seq + data.length);
        const text = data.toString("utf8");
        if (hub.pendingReplay !== undefined) hub.pendingReplay.push(text);
        else for (const subscriber of hub.subscribers) subscriber.send(text);
      },
      exit: () => {
        hub.exited = true;
        release(hub);
        for (const subscriber of hub.subscribers) subscriber.onExit();
        hubs.delete(hub.key);
      },
    };
    hub.listener = listener;
    client.onData(hub.id, listener.data);
    client.onExit(hub.id, listener.exit);
    hub.pendingReplay = [];
    try {
      const reply = await client.attach(hub.id, hub.lastSeq);
      hub.incarnation = reply.incarnation;
      const replay = hub.pendingReplay;
      hub.pendingReplay = undefined;
      if (reply.truncated) for (const subscriber of hub.subscribers) subscriber.send(RESET);
      for (const text of replay ?? []) for (const subscriber of hub.subscribers) subscriber.send(text);
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

const subscribe = async (hub: Hub, subscriber: Subscriber): Promise<void> => {
  if (hub.exited) {
    subscriber.onExit();
    return;
  }
  hub.subscribers.add(subscriber);
  await ensureAttached(hub);
  if (hub.exited) subscriber.onExit();
};

/** Start (or reuse) the change's active host window and hand back a session the socket drives.
 * Async so the route can start the host before upgrading. */
export const openSession = async (
  changeId: string,
  dir: string,
  size: { readonly cols: number; readonly rows: number },
): Promise<TerminalSession> => {
  const unavailable = terminalUnavailable();
  if (unavailable !== undefined) throw new Error(unavailable);
  const sessionId = await ensureActiveHostWindow(changeId, dir, size);
  const client = await hostClient();
  const incarnation = (await client.list()).find((entry) => entry.id === sessionId)?.incarnation ?? 0;
  const hub = hubFor(sessionId, incarnation);
  let subscriber: Subscriber | undefined;
  return {
    attach: (send, onExit) => {
      subscriber = { send, onExit };
      void subscribe(hub, subscriber).catch(() => subscriber?.onExit());
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
      // The last socket leaving releases the host listener; the shell keeps running and the next
      // attach resumes from `lastSeq` through the host's replay.
      if (hub.subscribers.size === 0 && !hub.exited) release(hub);
    },
  };
};

/** Drop every attachment. The host and its shells live on. */
export const closeAttachments = (): void => {
  for (const hub of hubs.values()) {
    release(hub);
    hub.subscribers.clear();
  }
  hubs.clear();
};

/** Attachment counts, for the tests that pin one-attach and no-listener-leak. */
export const hubStats = (): { hubs: number; attached: number; subscribers: number } => {
  let attached = 0;
  let subscribers = 0;
  for (const hub of hubs.values()) {
    if (hub.listener !== undefined) attached++;
    subscribers += hub.subscribers.size;
  }
  return { hubs: hubs.size, attached, subscribers };
};

/** The WebSocket handlers `server.ts` installs. Binary frames are keystrokes; a text frame is
 * the pane's `{type:"resize"}` control. */
export const terminalSockets = {
  open(ws: TerminalWebSocket): void {
    ws.data.session.attach(
      (chunk) => ws.send(chunk),
      () => ws.close(),
    );
  },
  message(ws: TerminalWebSocket, message: string | Uint8Array): void {
    if (typeof message === "string") {
      try {
        const value = JSON.parse(message) as { type?: unknown; cols?: unknown; rows?: unknown };
        if (value.type === "resize" && typeof value.cols === "number" && typeof value.rows === "number") {
          ws.data.session.resize(value.cols, value.rows);
        }
      } catch {
        // not a control frame: ignored
      }
      return;
    }
    ws.data.session.write(new TextDecoder().decode(message));
  },
  close(ws: TerminalWebSocket): void {
    ws.data.session.kill();
  },
};
