/**
 * A standalone terminal host: a process that owns ptys and outlives its clients.
 *
 * It listens on a unix socket and speaks newline-delimited JSON. Each connection must first
 * `hello` with the token from `<socket>.token` (mode 0600). The host writes three records
 * beside the socket, all mode 0600, **after** it is listening, so a client never reads a token
 * for a host that failed to bind:
 *
 *   <socket>.token       the bearer token for the hello
 *   <socket>.pid         the host's pid
 *   <socket>.owner.json  pid, checkout path, build id, runtime versions, protocol
 *
 * Client -> host:
 *   { type: "hello", token, requestId? }
 *   { type: "host.info", requestId? }
 *   { type: "host.shutdown", requestId? }           kill every pty, unlink records, exit
 *   { type: "session.open", id, cwd, command?, cols, rows, env?, requestId? }
 *   { type: "session.attach", id, since?, requestId? }   replay from byte offset `since`
 *   { type: "session.detach", id, requestId? }
 *   { type: "session.write", id, data: base64, requestId? }
 *   { type: "session.resize", id, cols, rows, requestId? }
 *   { type: "session.kill", id, requestId? }         signal the pty; the record is retained
 *   { type: "session.list", requestId? }
 *
 * Host -> client:
 *   { type: "welcome", requestId?, owner }
 *   { type: "ok", request, requestId?, ... }
 *   { type: "error", request, requestId?, message }
 *   { type: "data", id, incarnation, seq, data: base64 }
 *   { type: "exit", id, incarnation, exitCode, signal }
 *
 * Every reply echoes the request's `requestId`, so a client matches replies by id, not by type
 * order. `session.attach` on an unknown id is an `error` (it does not hang); `session.write` and
 * `session.resize` always answer `ok { applied }` (`applied:false` for a dead or unknown id).
 * Output and input are raw bytes end to end: the pty is spawned with `encoding: null`, its Buffer
 * output is base64'd straight through, and `session.write` decodes back to a Buffer.
 *
 * What the host owns across a client's life (this is the tmux property):
 *   - the pty and its shell, whether or not any client is attached;
 *   - the session record, keyed by id, with cwd / createdAt / pid / alive / lastSeq, so a new
 *     server can discover what survived with `session.list`;
 *   - a bounded (256 KB) byte replay buffer with offsets, so `attach` can resume from `since`.
 *     The attach reply carries the buffer's `oldestSeq` and `truncated` (true when `since`
 *     precedes it), so a resuming client knows it lost bytes rather than silently missing them;
 *   - the **exit** of a session: a dead session is *retained* (alive=false, exitCode, signal,
 *     exitedAt) rather than deleted. `attach` to it replays the buffer and then sends the final
 *     `exit`, so a later client gets a defined answer instead of hanging. `session.kill` signals
 *     the pty and the record is retained like any other exit. At most 64 dead sessions are
 *     retained, evicting the oldest `exitedAt` first;
 *   - **incarnation**: every `open` of an id gets a fresh, monotonically increasing incarnation.
 *     Data and exit events carry it, so a client can tell a reused id from the session it
 *     replaced; reopening a retained dead id detaches the old pty's subscribers, and the old
 *     pty's late output/exit is dropped rather than emitted for the reused id;
 *   - **identity**: every pty is seeded with `CORVI_SESSION_ID=<id>` and
 *     `CORVI_SESSION_INCARNATION=<n>`, so a reporter inside it can name its own session without
 *     guessing from tmux. A caller may add `env` on `session.open`; the host's identity wins;
 *   - **OSC status** (one transport): a reporter may emit `ESC ] 1337 ; corvi = <base64 json> BEL`
 *     (json `{status:"working"|"waiting"|"clear", name?, message?}`). The host parses it out of
 *     the pty stream, strips it before forwarding, records it on the session (see
 *     `session.list`'s `status`), and clears it on exit. Malformed or split sequences are held
 *     or dropped, never leaked to the display;
 *   - **idle shutdown**: with `--idle-ms N` (0 disables), once there are no client connections
 *     and no live sessions for `N` ms, the host shuts down. A live session always keeps it up,
 *     and an accepted connection cancels a pending shutdown.
 *
 * The client (server) owns what is *not* here: which change/window a session belongs to, labels,
 * agent status, and the registry that re-associates ids after a restart.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { loadNodePty, type IPty } from "./pty.ts";
import { PROTOCOL } from "./protocol.ts";
import { parseOsc } from "./osc.ts";

const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_DEAD_SESSIONS = 64;

const loaded = loadNodePty();
if ("error" in loaded) {
  console.error(`host: cannot load node-pty: ${loaded.error}`);
  process.exit(1);
}
const pty = loaded.module;

export type Owner = {
  readonly pid: number;
  readonly socket: string;
  readonly checkout: string;
  readonly buildId: string;
  readonly protocol: number;
  readonly startedAt: string;
  readonly node: string | undefined;
  readonly electron: string | undefined;
  readonly bun: string | undefined;
};

/** What `session.list` reports for one session (live or retained-dead). */
export type SessionInfo = {
  readonly id: string;
  readonly incarnation: number;
  readonly cwd: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly alive: boolean;
  readonly lastSeq: number;
  readonly exitCode?: number;
  readonly signal?: number;
  readonly exitedAt?: string;
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
  /** The parsed OSC status this session's reporter last sent, if any. */
  status?: {
    readonly state: "working" | "waiting";
    readonly name?: string;
    readonly message?: string;
    readonly sessionName?: string;
    readonly at: string;
  };
  /** Bytes held back because they might be the start of a split OSC status sequence. */
  oscCarry: Buffer;
  /** Set when this session object is superseded (killed-and-reopened); its late pty callbacks
   * must not emit for the reused id. */
  retired: boolean;
};

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const socketPath = argOf("--socket");
if (socketPath === undefined) {
  console.error("usage: host.ts --socket <path> [--checkout <path>] [--build-id <id>] [--idle-ms <n>]");
  process.exit(2);
}
const checkout = argOf("--checkout") ?? process.cwd();
const buildId = argOf("--build-id") ?? "unversioned";
const idleMs = Math.max(0, Number(argOf("--idle-ms") ?? 0) || 0);

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
const incarnations = new Map<string, number>();
const connections = new Set<Connection>();
/** When the host last saw activity; idle shutdown counts from here. */
let lastActive = Date.now();
/** A pending idle shutdown, cancelled by any activity (including an accepted connection). */
let idleTimer: ReturnType<typeof setTimeout> | undefined;

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

const respond = (connection: Connection, request: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
  send(connection.socket, { type: "ok", request: String(request.type), requestId: request.requestId, ...extra });
};

const fail = (connection: Connection, request: Record<string, unknown>, message: string): void => {
  send(connection.socket, { type: "error", request: String(request.type), requestId: request.requestId, message });
};

const trimBuffer = (session: Session): void => {
  while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
    session.bufferBytes -= session.buffer.shift()!.data.length;
  }
};

/** Oldest exit first. */
const evictDead = (): void => {
  const dead = [...sessions.values()]
    .filter((session) => !session.alive)
    .sort((a, b) => (a.exitedAt ?? "").localeCompare(b.exitedAt ?? ""));
  while (dead.length > MAX_DEAD_SESSIONS) {
    const victim = dead.shift()!;
    sessions.delete(victim.id);
  }
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
): { opened: boolean; incarnation: number } => {
  const existing = sessions.get(id);
  if (existing?.alive) return { opened: false, incarnation: existing.incarnation };
  // Replacing a retained dead id: detach the old session's subscribers and retire it, so its
  // late pty callbacks cannot emit for the reused id.
  if (existing) {
    existing.retired = true;
    existing.subscribers.clear();
  }
  const incarnation = (incarnations.get(id) ?? 0) + 1;
  incarnations.set(id, incarnation);
  const [file, ...args] = command;
  const child = pty.spawn(file ?? "/bin/sh", [...args], {
    name: "xterm-256color",
    cwd,
    cols,
    rows,
    // Raw bytes, not decoded strings: the pty owns the byte stream and so should we.
    encoding: null,
    // The reporter's identity is the host's to give: a caller's env cannot override it.
    env: {
      ...process.env,
      ...(env ?? {}),
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
    retired: false,
  };
  sessions.set(id, session);
  touch();
  child.onData((data) => {
    if (session.retired || sessions.get(id) !== session) return;
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const parsed = parseOsc(raw, session.oscCarry);
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
    // A dead session has no live reporter, so its status would be stale.
    session.status = undefined;
    touch();
    for (const connection of session.subscribers) {
      send(connection.socket, {
        type: "exit",
        id,
        incarnation: session.incarnation,
        exitCode,
        signal: sig,
      });
    }
    evictDead();
  });
  return { opened: true, incarnation };
};

/** Replay from `since` and report the session's state, including whether the buffer had already
 * dropped bytes before `since`. */
const attach = (
  connection: Connection,
  id: string,
  since: number,
): {
  attached: boolean;
  alive: boolean;
  incarnation: number;
  oldestSeq: number;
  truncated: boolean;
  exitCode?: number;
  signal?: number;
} => {
  const session = sessions.get(id);
  if (session === undefined) return { attached: false, alive: false, incarnation: 0, oldestSeq: 0, truncated: false };
  connection.subscriptions.add(id);
  session.subscribers.add(connection);
  const oldestSeq = session.buffer[0]?.offset ?? session.emitted;
  const truncated = since < oldestSeq;
  for (const entry of session.buffer) {
    const end = entry.offset + entry.data.length;
    if (end <= since) continue;
    const skip = Math.max(0, since - entry.offset);
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
    attached: true,
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
  }));

const handle = (connection: Connection, request: Record<string, unknown>): void => {
  const type = String(request.type);
  if (type !== "hello" && !connection.authed) {
    fail(connection, request, "hello first");
    return;
  }
  touch();
  const id = typeof request.id === "string" ? request.id : undefined;
  switch (type) {
    case "hello": {
      if (request.token !== token) {
        fail(connection, request, "bad token");
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
      // Reply, let the write drain, then tear down: a client that asked for shutdown can read
      // the answer before the socket dies under it.
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        shutdown();
      };
      connection.socket.write(
        `${JSON.stringify({ type: "ok", request: type, requestId: request.requestId })}\n`,
        finish,
      );
      setTimeout(finish, 250);
      return;
    }
    case "session.open": {
      if (id === undefined) {
        fail(connection, request, "id required");
        return;
      }
      const command = Array.isArray(request.command) ? (request.command as string[]) : ["/bin/sh"];
      const cols = typeof request.cols === "number" ? request.cols : 80;
      const rows = typeof request.rows === "number" ? request.rows : 24;
      const cwd = typeof request.cwd === "string" ? request.cwd : checkout;
      const env =
        typeof request.env === "object" && request.env !== null
          ? (request.env as Record<string, string>)
          : undefined;
      respond(connection, request, openSession(id, cwd, command, cols, rows, env));
      return;
    }
    case "session.attach": {
      if (id === undefined) {
        fail(connection, request, "id required");
        return;
      }
      if (!sessions.has(id)) {
        fail(connection, request, `no such session: ${id}`);
        return;
      }
      const since = typeof request.since === "number" ? request.since : 0;
      const result = attach(connection, id, since);
      respond(connection, request, result);
      // A dead session answers with its final state right after the replay.
      if (!result.alive) {
        send(connection.socket, {
          type: "exit",
          id,
          incarnation: result.incarnation,
          exitCode: result.exitCode ?? 0,
          signal: result.signal ?? 0,
        });
      }
      return;
    }
    case "session.detach":
      if (id !== undefined) detach(connection, id);
      respond(connection, request);
      return;
    case "session.write": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session && session.alive && typeof request.data === "string") {
        session.pty.write(Buffer.from(request.data, "base64"));
      }
      respond(connection, request, { applied: session !== undefined && session.alive });
      return;
    }
    case "session.resize": {
      const session = id === undefined ? undefined : sessions.get(id);
      const applied = session?.alive === true && typeof request.cols === "number" && typeof request.rows === "number";
      if (applied && session) {
        try {
          session.pty.resize(request.cols as number, request.rows as number);
        } catch {
          // exited between the lookup and the resize
        }
      }
      respond(connection, request, { applied });
      return;
    }
    case "session.kill": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session && session.alive) {
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
    default:
      fail(connection, request, `unknown request ${type}`);
  }
};

let server: Server | undefined;
let shuttingDown = false;

const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
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
  server?.close();
  for (const path of [`${socketPath}.token`, `${socketPath}.pid`, `${socketPath}.owner.json`, socketPath]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  process.exit(0);
};

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
      try {
        handle(connection, JSON.parse(line) as Record<string, unknown>);
      } catch (e) {
        send(socket, { type: "error", request: "parse", message: e instanceof Error ? e.message : String(e) });
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

// The socket must be 0600 the moment it exists, so tighten the umask across listen. The records
// are written only once we are listening: a failed bind leaves any existing host's records alone.
const previousUmask = process.umask(0o077);
server.on("error", (e) => {
  process.umask(previousUmask);
  // Never unlink records here: on EADDRINUSE they belong to the live host that already bound.
  console.error(`host: ${e.message}`);
  process.exit(1);
});
server.listen(socketPath, () => {
  process.umask(previousUmask);
  chmodSync(socketPath, 0o600);
  writeFileSync(`${socketPath}.token`, token, { mode: 0o600 });
  writeFileSync(`${socketPath}.pid`, String(process.pid), { mode: 0o600 });
  writeFileSync(`${socketPath}.owner.json`, JSON.stringify(owner), { mode: 0o600 });
  console.log(`host ${process.pid} listening on ${socketPath}`);
});

// Idle shutdown: no clients and no live sessions for idleMs means nothing here is worth
// outliving. A live session always resets the clock, so an unattended terminal is never killed.
if (idleMs > 0) {
  const period = Math.max(25, Math.floor(idleMs / 4));
  setInterval(() => {
    const alive = [...sessions.values()].some((session) => session.alive);
    if (connections.size === 0 && !alive && Date.now() - lastActive >= idleMs && idleTimer === undefined) {
      // Short grace: re-check once more so a connection accepted in the meantime cancels it.
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        const stillAlive = [...sessions.values()].some((session) => session.alive);
        if (connections.size === 0 && !stillAlive && Date.now() - lastActive >= idleMs) shutdown();
      }, 30);
    }
  }, period).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
