/**
 * One tmux client under a pseudoterminal, bridged to one browser socket.
 *
 * ttyd used to be this: an external process owning a port, a page and a pty. The pty is
 * node-pty's now, the page is the app's own xterm.js, and there is no port — the browser's
 * socket arrives at the server it already talks to.
 *
 * One connection is one tmux client: a second tab gets its own pty and its own size, and a
 * reload re-attaches with tmux's own redraw, while the session outlives all of them.
 *
 * The protocol on the socket, chosen so neither direction can be mistaken for the other:
 *
 *   - browser to server, binary: keystrokes; text: JSON control (`{"type":"resize",…}`);
 *   - server to browser, text: terminal output.
 *
 * A WebSocket connection owns its PTY attachment, not the persistent tmux session.
 */
import { spawn } from "node-pty";
import type { ServerWebSocket } from "../../capabilities/serve.ts";
import { commandAvailable } from "../../capabilities/os.ts";
import { childEnv } from "../../capabilities/env.ts";
import { env } from "../../capabilities/identity.ts";
import { attachCommand } from "./tmux.ts";

/** What the socket upgrade carries: the session the route already started, at the size the page
 * asked for. Spawning before the upgrade is what lets a failure come back as an HTTP answer the
 * pane can show, instead of a socket that opens and then says nothing. */
export type TerminalSocket = { session: TerminalSession };

/** A pty with one tmux client in it, as the socket bridge uses it. */
export type TerminalSession = {
  /** Start delivering output to this socket; whatever arrived before it attached goes first. */
  attach: (send: (chunk: string) => void, onExit: () => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

/** Bun loads the native addon but never delivers a byte of its output: its N-API shim does not
 * feed the pty's poll handle, so onData stays silent while spawn and exit work. Refuse rather
 * than open a socket that looks alive and is dead — `bun run dev` runs the server on Node, where
 * the terminal works (docs/manual/terminals.md). */
const onBun = (process.versions as Record<string, string | undefined>).bun !== undefined;

const missingTmux = (): Error => {
  const where = process.platform === "darwin" ? "macOS: brew install tmux" : "Arch: sudo pacman -S tmux";
  return new Error(`tmux is not installed — the terminal cannot start (${where})`);
};

/** Why a terminal cannot start here, if it cannot. The route that hands out the socket URL asks
 * this first, so the pane shows the reason instead of a socket that never connects. */
export const terminalUnavailable = (): string | undefined => {
  if (onBun) {
    return "the terminal needs Node — Bun never delivers pty output; run the server with Node (`bun run dev` does)";
  }
  if (!commandAvailable("tmux")) return missingTmux().message;
  return undefined;
};

/** The control frames the pane sends: a resize, and nothing else. */
const resizeOf = (message: string): { cols: number; rows: number } | undefined => {
  try {
    const value = JSON.parse(message) as { type?: string; cols?: unknown; rows?: unknown };
    if (value.type !== "resize" || typeof value.cols !== "number" || typeof value.rows !== "number") {
      return undefined;
    }
    return { cols: Math.max(1, Math.floor(value.cols)), rows: Math.max(1, Math.floor(value.rows)) };
  } catch {
    return undefined;
  }
};

/** Every pty this process has attached: the attachments are the server's to close when it
 * shuts down, while the tmux sessions — and the shells in them — stay for the next server. A
 * session removes itself when its socket closes, so this holds only live attachments. */
const attached = new Set<TerminalSession>();

/** Close every attached pty. The server calls this on shutdown; killing an attachment never
 * touches the session. */
export const closeAttachments = (): void => {
  for (const session of [...attached]) session.kill();
};

/** Start the change's tmux session under a pty, at the page's size. Throws when the runtime is
 * Bun or tmux is missing: the route turns that into the pane's error banner. */
export const openSession = (
  id: string,
  dir: string,
  size: { cols: number; rows: number },
): TerminalSession => {
  const unavailable = terminalUnavailable();
  if (unavailable) throw new Error(unavailable);

  const [file, ...args] = attachCommand(id, dir);
  const child = spawn(file!, args, {
    name: "xterm-256color",
    cols: Math.max(1, Math.floor(size.cols)),
    rows: Math.max(1, Math.floor(size.rows)),
    cwd: dir,
    // The pane's shells are the user's: the launcher's variables (ELECTRON_RUN_AS_NODE,
    // NODE_ENV, CORVI_PORT, CORVI_ROOT, …) are scrubbed, and the change's context is added on
    // purpose, so a script or an agent in the pane knows where it is (src/capabilities/env.ts).
    env: childEnv(process.env, { [env("CHANGE_ID")]: id, [env("CHANGE_DIR")]: dir }),
  });

  // Output can arrive before the upgrade has a socket to send it to (tmux starts fast): hold it
  // here, and the bridge flushes it on attach.
  const buffered: string[] = [];
  let send: ((chunk: string) => void) | undefined;
  let onExit: (() => void) | undefined;
  let exited = false;
  child.onData((chunk) => {
    if (send) send(chunk);
    else buffered.push(chunk);
  });
  child.onExit(() => {
    exited = true;
    onExit?.();
  });

  const session: TerminalSession = {
    attach: (toSocket, done) => {
      send = toSocket;
      onExit = done;
      for (const chunk of buffered) toSocket(chunk);
      buffered.length = 0;
      if (exited) done();
    },
    write: (data) => child.write(data),
    resize: (cols, rows) => {
      // A pty that has already exited refuses to resize; that is not a request failure.
      try {
        child.resize(cols, rows);
      } catch {
        // gone: the socket is closing too
      }
    },
    kill: () => {
      attached.delete(session);
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
  attached.add(session);
  return session;
};

/** The WebSocket handlers `server.ts` installs: one pty per connection, wired to its socket.
 * A tmux client that exits (its session was killed, or the user detached) closes the socket. */
export const terminalSockets = {
  open(ws: ServerWebSocket<TerminalSocket>): void {
    ws.data.session.attach(
      (chunk) => ws.send(chunk),
      () => ws.close(),
    );
  },

  message(ws: ServerWebSocket<TerminalSocket>, message: string | Uint8Array): void {
    // Text is control; binary is what you typed. Decoding the bytes as UTF-8 is what node-pty
    // writes back out, so a keystroke is never split or re-encoded on the way through.
    if (typeof message === "string") {
      const size = resizeOf(message);
      if (size) ws.data.session.resize(size.cols, size.rows);
      return;
    }
    ws.data.session.write(new TextDecoder().decode(message));
  },

  close(ws: ServerWebSocket<TerminalSocket>): void {
    ws.data.session.kill();
  },
};
