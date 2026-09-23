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
 *
 * The pty itself is the app's to start: node-pty is a native addon, and the environment a pane
 * gets is the app's scrubbing policy. This module takes a spawner and owns everything around
 * it — the buffer that holds output before the socket attaches, the attachments this process
 * has open, and the socket handlers that drive them.
 */

/** A pty with one client in it, as the spawner hands it over. */
export type PtyChild = {
  onData: (listener: (chunk: string) => void) => void;
  onExit: (listener: () => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

/** How the app starts a pty: the command tmux attaches with, and where the change is. The
 * environment is deliberately not part of this — the app builds it. */
export type PtySpawner = (input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly id: string;
  readonly dir: string;
}) => PtyChild;

/** A pty with one tmux client in it, as the socket bridge uses it. */
export type TerminalSession = {
  /** Start delivering output to this socket; whatever arrived before it attached goes first. */
  readonly attach: (send: (chunk: string) => void, onExit: () => void) => void;
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
  readonly send: (chunk: string) => void;
  readonly close: () => void;
};

/** The attachments one process owns, and the handlers that drive them. */
export type Attachments = {
  /** Start the change's tmux session under a pty, at the page's size. Throws when the spawner
   * cannot start the command: the route turns that into the pane's error banner. */
  readonly open: (
    id: string,
    dir: string,
    size: { readonly cols: number; readonly rows: number },
  ) => TerminalSession;
  /** Close every attached pty. The server calls this on shutdown; killing an attachment never
   * touches the session. */
  readonly closeAll: () => void;
  readonly sockets: {
    readonly open: (ws: TerminalWebSocket) => void;
    readonly message: (ws: TerminalWebSocket, message: string | Uint8Array) => void;
    readonly close: (ws: TerminalWebSocket) => void;
  };
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

export const makeAttachments = (
  attachCommand: (id: string, dir: string) => readonly string[],
  spawnPty: PtySpawner,
): Attachments => {
  /** Every pty this process has attached: the attachments are the server's to close when it
   * shuts down, while the tmux sessions — and the shells in them — stay for the next server. A
   * session removes itself when its socket closes, so this holds only live attachments. */
  const attached = new Set<TerminalSession>();

  const open = (
    id: string,
    dir: string,
    size: { readonly cols: number; readonly rows: number },
  ): TerminalSession => {
    const child = spawnPty({
      command: attachCommand(id, dir),
      cwd: dir,
      cols: Math.max(1, Math.floor(size.cols)),
      rows: Math.max(1, Math.floor(size.rows)),
      id,
      dir,
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

  return {
    open,
    closeAll: () => {
      for (const session of [...attached]) session.kill();
    },
    sockets: {
      /** A tmux client that exits (its session was killed, or the user detached) closes the
       * socket. */
      open(ws) {
        ws.data.session.attach(
          (chunk) => ws.send(chunk),
          () => ws.close(),
        );
      },
      message(ws, message) {
        // Text is control; binary is what you typed. Decoding the bytes as UTF-8 is what node-pty
        // writes back out, so a keystroke is never split or re-encoded on the way through.
        if (typeof message === "string") {
          const size = resizeOf(message);
          if (size) ws.data.session.resize(size.cols, size.rows);
          return;
        }
        ws.data.session.write(new TextDecoder().decode(message));
      },
      close(ws) {
        ws.data.session.kill();
      },
    },
  };
};
