/**
 * The terminal host: a process that owns ptys and outlives its clients.
 *
 * It listens on a unix socket and speaks the newline-delimited JSON protocol in `protocol.ts`.
 * Each connection first `hello`s with the token from `<socket>.token` (mode 0600). The host
 * writes three records beside the socket — token, pid, owner.json — all 0600, **after** it is
 * listening, so a client never reads a token for a host that failed to bind.
 *
 * What the host owns across a client's life (the "terminals survive a restart" property):
 *   - the pty and its shell, whether or not a client is attached;
 *   - the session record, keyed by id, with cwd / createdAt / pty pid / alive / lastSeq and the
 *     reporter's OSC status, discoverable with `session.list`;
 *   - a bounded (256 KB) byte replay buffer with offsets, so `attach since` can resume. The reply
 *     carries `oldestSeq` and `truncated` (a `since` before the buffer start);
 *   - the **exit** of a session: a dead session is retained (exitCode, signal, exitedAt) rather
 *     than deleted, and `attach` replays its buffer then sends the final `exit`; `kill` signals
 *     the pty and the record is retained like any other exit. At most 64 dead sessions are kept,
 *     evicting the oldest exit first;
 *   - **incarnation**: every `open` of an id gets a fresh, monotonically increasing incarnation.
 *     Data and exit events carry it, so a client can tell a reused id from the session it
 *     replaced; reopening a retained dead id retires the old pty so its late callbacks cannot
 *     emit for the reused id;
 *   - **identity**: every pty is seeded with `CORVI_SESSION_ID` and `CORVI_SESSION_INCARNATION`,
 *     so a reporter inside it can name its own session; a caller's `env` cannot override them;
 *   - **OSC status**: a reporter may emit `ESC ] 1337 ; corvi = <base64 json> BEL`; the host
 *     parses it out of the pty stream (see `osc.ts`), strips it before forwarding, records it on
 *     the session, and clears it on exit;
 *   - **idle shutdown**: with `idleMs > 0`, once there are no client connections and no live
 *     sessions for that long, the host closes. A live session always keeps it up, and an accepted
 *     connection cancels a pending shutdown.
 *
 * The client (the server) owns what is not here: which change/window a session belongs to,
 * labels, the agent-status registry, and re-association after a restart.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type IPty } from "node-pty";
import { parseRequest, requestIdFrom, requestTypeOf, PROTOCOL, type HostRequest, type Owner, type SessionInfo } from "./protocol.ts";
import { parseOsc } from "./osc.ts";

const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_DEAD_SESSIONS = 64;

export type HostOptions = {
  /** Where the unix socket lives. The token/pid/owner records are written beside it. */
  readonly socketPath: string;
  /** The checkout this host was started from, recorded so a client can detect a stale host. */
  readonly checkout?: string;
  /** The build identity, recorded for the same reason. */
  readonly buildId?: string;
  /** Close after this many ms with no client and no live session; 0 disables. */
  readonly idleMs?: number;
  /** Called once after a close finishes. `main.ts` uses it to end the process, which the signal
   * listeners would otherwise keep alive. */
  readonly onClosed?: () => void;
};

export type HostHandle = {
  readonly owner: Owner;
  /** Kill every pty, unlink the records, close the socket. Idempotent. */
  readonly close: () => Promise<void>;
};

type Connection = {
  readonly socket: Socket;
  authed: boolean;
  readonly subscriptions: Set<string>;
};

/** One chunk of output as it sat in the stream: `offset` is the byte offset of its first byte. */
type Buffered = { readonly offset: number; readonly data: Buffer };

type Session = {
  readonly id: string;
  readonly incarnation: number;
  readonly pty: IPty;
  readonly cwd: string;
  readonly createdAt: string;
  readonly buffer: Buffered[];
  bufferBytes: number;
  /** Total bytes emitted for this session: the next chunk's offset. */
  emitted: number;
  readonly subscribers: Set<Connection>;
  alive: boolean;
  exitCode?: number;
  signal?: number;
  exitedAt?: string;
  /** The parsed OSC status the reporter last sent, if any. */
  status?: {
    readonly state: "working" | "waiting";
    readonly name?: string;
    readonly message?: string;
    readonly sessionName?: string;
    readonly at: string;
  };
  /** Bytes held because they might be the start of a split OSC sequence. */
  oscCarry: Buffer;
  /** The server's opaque metadata (at least a change id), returned by `session.list` so it can
   * rebuild its registry after a restart. */
  readonly metadata?: Record<string, string>;
  /** Set when this session object is superseded (killed-and-reopened); its late pty callbacks
   * must not emit for the reused id. */
  retired: boolean;
};

/** node-pty yields a Buffer once spawned with `encoding: null`; the typings still say string. */
const asBuffer = (data: string): Buffer => (Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));

const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
};

export const startHost = async (options: HostOptions): Promise<HostHandle> => {
  const socketPath = options.socketPath;
  const checkout = options.checkout ?? process.cwd();
  const buildId = options.buildId ?? "unversioned";
  const idleMs = Math.max(0, options.idleMs ?? 0);

  const token = randomBytes(24).toString("hex");
  const owner: Owner = {
    pid: process.pid,
    socket: socketPath,
    checkout,
    buildId,
    protocol: PROTOCOL,
    startedAt: new Date().toISOString(),
    node: process.versions.node,
    electron: process.versions.electron,
    bun: process.versions.bun,
  };

  const sessions = new Map<string, Session>();
  // One number per id this host has opened, so a reopened id gets a fresh incarnation. A host
  // lives for one app session and ids are bounded by open windows, so this does not need
  // eviction; it would only matter if a host were long-lived across many distinct ids.
  const incarnations = new Map<string, number>();
  const connections = new Set<Connection>();
  let lastActive = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /** Record activity and cancel any idle shutdown already in flight. */
  const touch = (): void => {
    lastActive = Date.now();
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const send = (socket: Socket, message: unknown): void => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (connection: Connection, request: HostRequest, extra: Record<string, unknown> = {}): void => {
    send(connection.socket, { type: "ok", request: request.type, requestId: request.requestId, ...extra });
  };

  const fail = (connection: Connection, request: HostRequest | undefined, type: string, message: string): void => {
    send(connection.socket, { type: "error", request: type, requestId: request?.requestId, message });
  };

  const trimBuffer = (session: Session): void => {
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      session.bufferBytes -= session.buffer.shift()!.data.length;
    }
  };

  /** Evict retained dead sessions oldest-exit-first. */
  const evictDead = (): void => {
    const dead = [...sessions.values()]
      .filter((session) => !session.alive)
      .sort((a, b) => (a.exitedAt ?? "").localeCompare(b.exitedAt ?? ""));
    while (dead.length > MAX_DEAD_SESSIONS) sessions.delete(dead.shift()!.id);
  };

  /** Append bytes to a session's replay buffer and stream them to its subscribers. */
  const emitChunk = (session: Session, chunk: Buffer): void => {
    if (chunk.length === 0) return;
    const entry: Buffered = { offset: session.emitted, data: chunk };
    session.emitted += chunk.length;
    session.buffer.push(entry);
    session.bufferBytes += chunk.length;
    trimBuffer(session);
    for (const connection of session.subscribers) {
      send(connection.socket, {
        type: "data",
        id: session.id,
        incarnation: session.incarnation,
        seq: entry.offset,
        data: chunk.toString("base64"),
      });
    }
  };

  const openSession = (
    id: string,
    cwd: string,
    command: readonly string[],
    cols: number,
    rows: number,
    env: Record<string, string> | undefined,
    metadata: Record<string, string> | undefined,
  ): { opened: boolean; incarnation: number } => {
    const existing = sessions.get(id);
    if (existing?.alive) return { opened: false, incarnation: existing.incarnation };
    // Replacing a retained dead id: retire the old session so its late callbacks cannot emit.
    if (existing) {
      existing.retired = true;
      existing.subscribers.clear();
    }
    const incarnation = (incarnations.get(id) ?? 0) + 1;
    incarnations.set(id, incarnation);
    const [file, ...args] = command;
    const child = spawn(file ?? "/bin/sh", [...args], {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      // Raw bytes, not decoded strings: the pty owns the byte stream and so should we.
      encoding: null,
      // A caller's env is the whole environment, not an extension of the host's: the server
      // scrubs the launcher's variables before sending, and merging the host's own env back in
      // would reinstate exactly the keys the scrub removed.
      env: {
        ...(env ?? baseEnv()),
        TERM: "xterm-256color",
        CORVI_SESSION_ID: id,
        CORVI_SESSION_INCARNATION: String(incarnation),
      },
    });
    const session: Session = {
      id,
      incarnation,
      pty: child,
      cwd,
      createdAt: new Date().toISOString(),
      buffer: [],
      bufferBytes: 0,
      emitted: 0,
      subscribers: new Set(),
      alive: true,
      oscCarry: Buffer.alloc(0),
      ...(metadata !== undefined ? { metadata } : {}),
      retired: false,
    };
    sessions.set(id, session);
    touch();
    child.onData((data) => {
      if (session.retired || sessions.get(id) !== session) return;
      const parsed = parseOsc(asBuffer(data), session.oscCarry);
      session.oscCarry = parsed.carry;
      for (const status of parsed.statuses) {
        session.status =
          status.status === "clear"
            ? undefined
            : {
                state: status.status,
                ...(status.name ? { name: status.name } : {}),
                ...(status.message ? { message: status.message } : {}),
                ...(status.sessionName ? { sessionName: status.sessionName } : {}),
                at: new Date().toISOString(),
              };
      }
      emitChunk(session, parsed.clean);
    });
    child.onExit(({ exitCode, signal }) => {
      if (session.retired || sessions.get(id) !== session) return;
      // Flush a held partial introducer: session end must not swallow real bytes.
      const carry = session.oscCarry;
      session.oscCarry = Buffer.alloc(0);
      emitChunk(session, carry);
      const sig = typeof signal === "number" && signal > 0 ? signal : 0;
      // Retain the record: a later attach must get a defined final state, not a hang.
      session.alive = false;
      session.exitCode = exitCode;
      session.signal = sig;
      session.exitedAt = new Date().toISOString();
      session.status = undefined;
      touch();
      for (const connection of session.subscribers) {
        send(connection.socket, { type: "exit", id, incarnation: session.incarnation, exitCode, signal: sig });
      }
      evictDead();
    });
    return { opened: true, incarnation };
  };

  type AttachReply = {
    alive: boolean;
    incarnation: number;
    oldestSeq: number;
    truncated: boolean;
    exitCode?: number;
    signal?: number;
  };

  /** Replay from `since` and report the session's state, including whether the buffer had already
   * dropped bytes before `since`. A negative `since` is clamped to the start. */
  const attach = (connection: Connection, id: string, since: number): AttachReply => {
    const session = sessions.get(id);
    if (session === undefined) return { alive: false, incarnation: 0, oldestSeq: 0, truncated: false };
    const from = Math.max(0, since);
    connection.subscriptions.add(id);
    session.subscribers.add(connection);
    const oldestSeq = session.buffer[0]?.offset ?? session.emitted;
    const truncated = from < oldestSeq;
    for (const entry of session.buffer) {
      const end = entry.offset + entry.data.length;
      if (end <= from) continue;
      const skip = Math.max(0, from - entry.offset);
      const data = skip === 0 ? entry.data : entry.data.subarray(skip);
      send(connection.socket, {
        type: "data",
        id,
        incarnation: session.incarnation,
        seq: entry.offset + skip,
        data: data.toString("base64"),
      });
    }
    return {
      alive: session.alive,
      incarnation: session.incarnation,
      oldestSeq,
      truncated,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
    };
  };

  const detach = (connection: Connection, id: string): void => {
    connection.subscriptions.delete(id);
    sessions.get(id)?.subscribers.delete(connection);
  };

  const listSessions = (): SessionInfo[] =>
    [...sessions.values()].map((session) => ({
      id: session.id,
      incarnation: session.incarnation,
      cwd: session.cwd,
      pid: session.pty.pid,
      createdAt: session.createdAt,
      alive: session.alive,
      lastSeq: session.emitted,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      ...(session.exitedAt !== undefined ? { exitedAt: session.exitedAt } : {}),
      ...(session.status !== undefined ? { status: session.status } : {}),
      ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
    }));

  const handle = (connection: Connection, value: unknown): void => {
    const request = parseRequest(value);
    if (request === undefined) {
      const type = requestTypeOf(value);
      const requestId = requestIdFrom(value);
      send(connection.socket, {
        type: "error",
        request: type,
        ...(requestId !== undefined ? { requestId } : {}),
        message: `unknown or malformed request: ${type}`,
      });
      return;
    }
    if (request.type !== "hello" && !connection.authed) {
      fail(connection, request, request.type, "hello first");
      return;
    }
    touch();
    switch (request.type) {
      case "hello": {
        if (request.token !== token) {
          fail(connection, request, request.type, "bad token");
          connection.socket.end();
          return;
        }
        connection.authed = true;
        send(connection.socket, { type: "welcome", requestId: request.requestId, owner });
        return;
      }
      case "host.info":
        respond(connection, request, { owner });
        return;
      case "host.shutdown": {
        // Reply, let the write drain, then tear down: the client can read the answer first.
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          void close();
        };
        connection.socket.write(`${JSON.stringify({ type: "ok", request: request.type, requestId: request.requestId })}\n`, finish);
        setTimeout(finish, 250);
        return;
      }
      case "session.open":
        respond(
          connection,
          request,
          openSession(
            request.id,
            request.cwd ?? checkout,
            request.command ?? ["/bin/sh"],
            request.cols ?? 80,
            request.rows ?? 24,
            request.env,
            request.metadata,
          ),
        );
        return;
      case "session.attach": {
        if (!sessions.has(request.id)) {
          fail(connection, request, request.type, `no such session: ${request.id}`);
          return;
        }
        const result = attach(connection, request.id, request.since ?? 0);
        respond(connection, request, result);
        // A dead session answers with its final state right after the replay.
        if (!result.alive) {
          send(connection.socket, {
            type: "exit",
            id: request.id,
            incarnation: result.incarnation,
            exitCode: result.exitCode ?? 0,
            signal: result.signal ?? 0,
          });
        }
        return;
      }
      case "session.detach":
        if (request.id !== undefined) detach(connection, request.id);
        respond(connection, request);
        return;
      case "session.write": {
        const session = request.id === undefined ? undefined : sessions.get(request.id);
        const applied = session?.alive === true && request.data !== undefined;
        if (applied && request.data !== undefined) session.pty.write(Buffer.from(request.data, "base64"));
        respond(connection, request, { applied });
        return;
      }
      case "session.resize": {
        const session = request.id === undefined ? undefined : sessions.get(request.id);
        const applied = session?.alive === true && request.cols !== undefined && request.rows !== undefined;
        if (applied && session !== undefined && request.cols !== undefined && request.rows !== undefined) {
          try {
            session.pty.resize(request.cols, request.rows);
          } catch {
            // exited between the lookup and the resize
          }
        }
        respond(connection, request, { applied });
        return;
      }
      case "session.kill": {
        const session = request.id === undefined ? undefined : sessions.get(request.id);
        if (session?.alive) {
          // Signal it and let onExit retain the record with its real exit code and signal, so a
          // killed shell is distinguishable from a typed `exit`.
          try {
            session.pty.kill();
          } catch {
            // already gone
          }
        }
        respond(connection, request);
        return;
      }
      case "session.list":
        respond(connection, request, { sessions: listSessions() });
        return;
    }
  };

  let server: Server | undefined;
  let closing = false;
  let idleInterval: ReturnType<typeof setInterval> | undefined;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    if (idleInterval !== undefined) {
      clearInterval(idleInterval);
      idleInterval = undefined;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    for (const session of sessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // already gone
      }
    }
    sessions.clear();
    for (const connection of connections) connection.socket.destroy();
    connections.clear();
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    for (const path of [`${socketPath}.token`, `${socketPath}.pid`, `${socketPath}.owner.json`, socketPath]) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
    options.onClosed?.();
  };

  await new Promise<void>((resolve, reject) => {
    server = createServer((socket) => {
      const connection: Connection = { socket, authed: false, subscriptions: new Set() };
      // An accepted connection is activity: cancel any idle shutdown already in flight.
      touch();
      connections.add(connection);
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (data: string) => {
        pending += data;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline === -1) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.trim() === "") continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch (error) {
            // A line that is not JSON cannot carry a requestId; the client surfaces it as a
            // protocol error rather than a reply to any call.
            send(socket, { type: "error", request: "parse", message: error instanceof Error ? error.message : String(error) });
            continue;
          }
          try {
            handle(connection, value);
          } catch (error) {
            // A throw inside handling still answers the caller, with its requestId when it had
            // one.
            const requestId = requestIdFrom(value);
            send(socket, {
              type: "error",
              request: requestTypeOf(value),
              ...(requestId !== undefined ? { requestId } : {}),
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
      socket.on("close", () => {
        connections.delete(connection);
        for (const id of connection.subscriptions) sessions.get(id)?.subscribers.delete(connection);
        touch();
      });
      socket.on("error", () => socket.destroy());
    });

    // The socket must be 0600 the moment it exists, so tighten the umask across listen. The
    // records are written only once we are listening: a failed bind leaves any existing host's
    // records alone.
    const previousUmask = process.umask(0o077);
    server.on("error", (error) => {
      process.umask(previousUmask);
      if (!server?.listening) reject(error);
      else console.error(`terminal host: ${error.message}`);
    });
    server.listen(socketPath, () => {
      process.umask(previousUmask);
      chmodSync(socketPath, 0o600);
      writeFileSync(`${socketPath}.token`, token, { mode: 0o600 });
      writeFileSync(`${socketPath}.pid`, String(process.pid), { mode: 0o600 });
      writeFileSync(`${socketPath}.owner.json`, JSON.stringify(owner), { mode: 0o600 });
      resolve();
    });
  });

  // Idle shutdown: no clients and no live sessions for idleMs means nothing here is worth
  // outliving. A live session always resets the clock, so an unattended terminal is never killed.
  if (idleMs > 0) {
    const period = Math.max(25, Math.floor(idleMs / 4));
    idleInterval = setInterval(() => {
      const alive = [...sessions.values()].some((session) => session.alive);
      if (connections.size === 0 && !alive && Date.now() - lastActive >= idleMs && idleTimer === undefined) {
        // Short grace: re-check once more so a connection accepted in the meantime cancels it.
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          const stillAlive = [...sessions.values()].some((session) => session.alive);
          if (connections.size === 0 && !stillAlive && Date.now() - lastActive >= idleMs) void close();
        }, 30);
      }
    }, period);
    idleInterval.unref();
  }

  return { owner, close };
};
