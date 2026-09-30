/**
 * The WebSocket's terminal half: one attach per connection to a host session, fanned out to the
 * page.
 *
 * The host owns the pty; this process only holds the connection. Each host session has one hub
 * that subscribes to the host and buffers output until a socket attaches, then streams to every
 * attached socket. `kill()` here means detach, never kill: closing a page leaves the shell
 * running, which is the property the whole change is about.
 */
import type { TerminalSession, TerminalSocket, TerminalWebSocket } from "@corvi/terminals/session";
import { hostClient } from "./host.ts";
import { ensureActiveHostWindow } from "./windows.ts";

export type { TerminalSession, TerminalSocket } from "@corvi/terminals/session";

const onBun = (process.versions as Record<string, string | undefined>).bun !== undefined;

/** Why a terminal cannot start here, if it cannot. The route asks first, so the pane shows the
 * reason instead of opening a socket that never speaks. */
export const terminalUnavailable = (): string | undefined =>
  onBun ? "the terminal needs Node — Bun never delivers pty output; run the server with Node (`bun run dev` does)" : undefined;

type Subscriber = { readonly send: (chunk: string) => void; readonly onExit: () => void };

type Hub = {
  readonly id: string;
  readonly buffer: string[];
  readonly subscribers: Set<Subscriber>;
  exited: boolean;
};

const hubs = new Map<string, Hub>();

const hubFor = async (id: string): Promise<Hub> => {
  const existing = hubs.get(id);
  if (existing !== undefined) return existing;
  const client = await hostClient();
  const hub: Hub = { id, buffer: [], subscribers: new Set(), exited: false };
  client.onData(id, (data) => {
    const text = data.toString("utf8");
    if (hub.subscribers.size === 0) hub.buffer.push(text);
    for (const subscriber of hub.subscribers) subscriber.send(text);
  });
  client.onExit(id, () => {
    hub.exited = true;
    for (const subscriber of hub.subscribers) subscriber.onExit();
  });
  // Attach from the start: this both subscribes and fills the buffer with the host's replay.
  await client.attach(id, 0);
  hubs.set(id, hub);
  return hub;
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
  const hub = await hubFor(sessionId);
  const client = await hostClient();
  let subscriber: Subscriber | undefined;
  return {
    attach: (send, onExit) => {
      subscriber = { send, onExit };
      hub.subscribers.add(subscriber);
      for (const chunk of hub.buffer) send(chunk);
      hub.buffer.length = 0;
      if (hub.exited) onExit();
    },
    write: (data) => {
      void client.write(sessionId, data);
    },
    resize: (cols, rows) => {
      void client.resize(sessionId, cols, rows);
    },
    kill: () => {
      if (subscriber !== undefined) hub.subscribers.delete(subscriber);
      subscriber = undefined;
    },
  };
};

/** Drop every attachment. The host and its shells live on. */
export const closeAttachments = (): void => {
  for (const hub of hubs.values()) hub.subscribers.clear();
  hubs.clear();
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
