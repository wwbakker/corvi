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
 *   { type: "session.kill", id, requestId? }
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
 * Buffer output is base64'd straight through, and `session.write` decodes back to a Buffer. A
 * session keeps its pty (and a bounded replay buffer with byte offsets) whether or not a client
 * is attached; detaching never kills the shell, and `attach` with `since` skips output the client
 * already has.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { loadNodePty, type IPty } from "./pty.ts";

const MAX_BUFFER_BYTES = 256 * 1024;
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
  readonly buffer: Buffered[];
  bufferBytes: number;
  /** Total bytes emitted for this session: the next chunk's offset. */
  emitted: number;
  readonly subscribers: Set<Connection>;
  alive: boolean;
};

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const socketPath = argOf("--socket");
if (socketPath === undefined) {
  console.error("usage: host.ts --socket <path> [--checkout <path>] [--build-id <id>]");
  process.exit(2);
}
const checkout = argOf("--checkout") ?? process.cwd();
const buildId = argOf("--build-id") ?? "unversioned";

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
    buffer: [],
    bufferBytes: 0,
    emitted: 0,
    subscribers: new Set(),
    alive: true,
  };
  sessions.set(id, session);
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
    session.alive = false;
    for (const connection of session.subscribers) {
      send(connection.socket, { type: "exit", id, exitCode });
    }
    sessions.delete(id);
  });
  return { opened: true };
};

const attach = (connection: Connection, id: string, since: number): { attached: boolean } => {
  const session = sessions.get(id);
  if (session === undefined) return { attached: false };
  connection.subscriptions.add(id);
  session.subscribers.add(connection);
  for (const entry of session.buffer) {
    const end = entry.offset + entry.data.length;
    if (end <= since) continue;
    const skip = Math.max(0, since - entry.offset);
    const data = skip === 0 ? entry.data : entry.data.subarray(skip);
    send(connection.socket, { type: "data", id, seq: entry.offset + skip, data: data.toString("base64") });
  }
  return { attached: true };
};

const detach = (connection: Connection, id: string): void => {
  connection.subscriptions.delete(id);
  sessions.get(id)?.subscribers.delete(connection);
};

const handle = (connection: Connection, request: Record<string, unknown>): void => {
  const type = String(request.type);
  if (type !== "hello" && !connection.authed) {
    fail(connection, request, "hello first");
    return;
  }
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
      respond(connection, request, attach(connection, id, since));
      return;
    }
    case "session.detach":
      if (id !== undefined) detach(connection, id);
      respond(connection, request);
      return;
    case "session.write": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session && typeof request.data === "string") {
        session.pty.write(Buffer.from(request.data, "base64"));
      }
      return;
    }
    case "session.resize": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session && typeof request.cols === "number" && typeof request.rows === "number") {
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
      }
      respond(connection, request);
      return;
    }
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

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
