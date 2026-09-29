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
 *   { type: "session.open", id, cwd, command?, cols, rows, requestId? }
 *   { type: "session.attach", id, since?, requestId? }   replay from byte offset `since`
 *   { type: "session.detach", id, requestId? }
 *   { type: "session.write", id, data: base64 }
 *   { type: "session.resize", id, cols, rows }
 *   { type: "session.kill", id, requestId? }         kill the pty and forget the record
 *   { type: "session.list", requestId? }
 *
 * Host -> client:
 *   { type: "welcome", requestId?, owner }
 *   { type: "ok", request, requestId?, ... }
 *   { type: "error", request, requestId?, message }
 *   { type: "data", id, seq, data: base64 }         seq is the offset of the first byte
 *   { type: "exit", id, exitCode }
 *
 * Every reply echoes the request's `requestId`, so a client matches replies by id, not by type
 * order. Output and input are raw bytes end to end: the pty is spawned with `encoding: null`, its
 * Buffer output is base64'd straight through, and `session.write` decodes back to a Buffer.
 *
 * What the host owns across a client's life (this is the tmux property):
 *   - the pty and its shell, whether or not any client is attached;
 *   - the session record, keyed by id, with cwd / createdAt / pid / alive / lastSeq, so a new
 *     server can discover what survived with `session.list`;
 *   - a bounded (256 KB) byte replay buffer with offsets, so `attach` can resume from `since`;
 *   - the **exit** of a session: a dead session is *retained* (alive=false, exitCode, exitedAt)
 *     rather than deleted. `attach` to it replays the buffer and then sends the final `exit`, so
 *     a later client gets a defined answer instead of hanging. `session.kill` deletes the record.
 *     At most 64 dead sessions are retained; older ones are evicted.
 *   - **idle shutdown**: with `--idle-ms N` (0 disables), once there are no client connections
 *     and no live sessions for `N` ms, the host shuts down. A live session always keeps it up.
 *
 * The client (server) owns what is *not* here: which change/window a session belongs to, labels,
 * agent status, and the registry that re-associates ids after a restart.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { loadNodePty, type IPty } from "./pty.ts";

const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_DEAD_SESSIONS = 64;
/** Bumped when the wire protocol changes incompatibly; a client refuses a host whose protocol
 * differs (see client.ts). */
export const PROTOCOL = 1;

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
  readonly cwd: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly alive: boolean;
  readonly lastSeq: number;
  readonly exitCode?: number;
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
  exitedAt?: string;
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
const connections = new Set<Connection>();
/** When the host last saw activity; idle shutdown counts from here. */
let lastActive = Date.now();
const touch = (): void => {
  lastActive = Date.now();
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

const evictDead = (): void => {
  const dead = [...sessions.values()].filter((session) => !session.alive);
  while (dead.length > MAX_DEAD_SESSIONS) {
    const victim = dead.shift()!;
    sessions.delete(victim.id);
  }
};

const openSession = (
  id: string,
  cwd: string,
  command: readonly string[],
  cols: number,
  rows: number,
): { opened: boolean } => {
  const existing = sessions.get(id);
  if (existing?.alive) return { opened: false };
  const [file, ...args] = command;
  const child = pty.spawn(file ?? "/bin/sh", [...args], {
    name: "xterm-256color",
    cwd,
    cols,
    rows,
    // Raw bytes, not decoded strings: the pty owns the byte stream and so should we.
    encoding: null,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  const session: Session = {
    id,
    pty: child,
    cwd,
    createdAt: new Date().toISOString(),
    buffer: [],
    bufferBytes: 0,
    emitted: 0,
    subscribers: new Set(),
    alive: true,
  };
  sessions.set(id, session);
  touch();
  child.onData((data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const entry: Buffered = { offset: session.emitted, data: chunk };
    session.emitted += chunk.length;
    session.buffer.push(entry);
    session.bufferBytes += chunk.length;
    trimBuffer(session);
    for (const connection of session.subscribers) {
      send(connection.socket, { type: "data", id, seq: entry.offset, data: chunk.toString("base64") });
    }
  });
  child.onExit(({ exitCode }) => {
    // Retain the record: a later attach must get a defined final state, not a hang.
    session.alive = false;
    session.exitCode = exitCode;
    session.exitedAt = new Date().toISOString();
    touch();
    for (const connection of session.subscribers) {
      send(connection.socket, { type: "exit", id, exitCode });
    }
    evictDead();
  });
  return { opened: true };
};

/** Replay from `since` and report the session's state. A dead session's replay ends with an
 * `exit` event sent by the caller. */
const attach = (
  connection: Connection,
  id: string,
  since: number,
): { attached: boolean; alive: boolean; exitCode?: number } => {
  const session = sessions.get(id);
  if (session === undefined) return { attached: false, alive: false };
  connection.subscriptions.add(id);
  session.subscribers.add(connection);
  for (const entry of session.buffer) {
    const end = entry.offset + entry.data.length;
    if (end <= since) continue;
    const skip = Math.max(0, since - entry.offset);
    const data = skip === 0 ? entry.data : entry.data.subarray(skip);
    send(connection.socket, { type: "data", id, seq: entry.offset + skip, data: data.toString("base64") });
  }
  return { attached: true, alive: session.alive, exitCode: session.exitCode };
};

const detach = (connection: Connection, id: string): void => {
  connection.subscriptions.delete(id);
  sessions.get(id)?.subscribers.delete(connection);
};

const listSessions = (): SessionInfo[] =>
  [...sessions.values()].map((session) => ({
    id: session.id,
    cwd: session.cwd,
    pid: session.pty.pid,
    createdAt: session.createdAt,
    alive: session.alive,
    lastSeq: session.emitted,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
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
      respond(connection, request, openSession(id, cwd, command, cols, rows));
      return;
    }
    case "session.attach": {
      if (id === undefined) return;
      const since = typeof request.since === "number" ? request.since : 0;
      const result = attach(connection, id, since);
      respond(connection, request, result);
      // A dead session answers with its final state right after the replay.
      if (result.attached && !result.alive) {
        send(connection.socket, { type: "exit", id, exitCode: result.exitCode ?? 0 });
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
      return;
    }
    case "session.resize": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session?.alive && typeof request.cols === "number" && typeof request.rows === "number") {
        try {
          session.pty.resize(request.cols, request.rows);
        } catch {
          // exited between the lookup and the resize
        }
      }
      return;
    }
    case "session.kill": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session) {
        try {
          session.pty.kill();
        } catch {
          // already gone
        }
        sessions.delete(id!);
        touch();
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
  connections.add(connection);
  touch();
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
    if (connections.size === 0 && !alive && Date.now() - lastActive >= idleMs) shutdown();
  }, period).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
