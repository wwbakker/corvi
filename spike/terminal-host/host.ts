/**
 * A standalone terminal host: a process that owns ptys and outlives its clients.
 *
 * It listens on a unix socket and speaks newline-delimited JSON. Each connection must first
 * `hello` with the token from `<socket>.token` (mode 0600). The host writes three records
 * beside the socket, all mode 0600:
 *
 *   <socket>.token       the bearer token for the hello
 *   <socket>.pid         the host's pid
 *   <socket>.owner.json  pid, checkout path, build id, runtime versions, protocol
 *
 * Client -> host:
 *   { type: "hello", token }
 *   { type: "host.info" }
 *   { type: "host.shutdown" }                       kill every pty, unlink records, exit
 *   { type: "session.open", id, cwd, command?, cols, rows }
 *   { type: "session.attach", id }                  replay buffered output, then stream
 *   { type: "session.detach", id }
 *   { type: "session.write", id, data: base64 }
 *   { type: "session.resize", id, cols, rows }
 *   { type: "session.kill", id }
 *
 * Host -> client:
 *   { type: "welcome", owner }
 *   { type: "ok", request, ... }
 *   { type: "error", request, message }
 *   { type: "data", id, data: base64 }
 *   { type: "exit", id, exitCode }
 *
 * Output is base64 so a line boundary in the JSON framing can never be mistaken for terminal
 * output. A session keeps its pty (and a bounded replay buffer) whether or not a client is
 * attached; detaching never kills the shell.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { loadNodePty, type IPty } from "./pty.ts";

const MAX_BUFFER_BYTES = 256 * 1024;

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

type Session = {
  readonly id: string;
  readonly pty: IPty;
  readonly buffer: Buffer[];
  bufferBytes: number;
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
  protocol: 1,
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

const broadcast = (session: Session, message: unknown): void => {
  for (const connection of session.subscribers) send(connection.socket, message);
};

const forward = (session: Session, chunk: Buffer): void => {
  broadcast(session, { type: "data", id: session.id, data: chunk.toString("base64") });
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
    env: { ...process.env, TERM: "xterm-256color" },
  });
  const session: Session = { id, pty: child, buffer: [], bufferBytes: 0, subscribers: new Set(), alive: true };
  sessions.set(id, session);
  child.onData((data) => {
    const chunk = Buffer.from(data, "utf8");
    session.buffer.push(chunk);
    session.bufferBytes += chunk.length;
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      session.bufferBytes -= session.buffer.shift()!.length;
    }
    forward(session, chunk);
  });
  child.onExit(({ exitCode }) => {
    session.alive = false;
    broadcast(session, { type: "exit", id, exitCode });
    sessions.delete(id);
  });
  return { opened: true };
};

const attach = (connection: Connection, id: string): { attached: boolean } => {
  const session = sessions.get(id);
  if (session === undefined) return { attached: false };
  connection.subscriptions.add(id);
  session.subscribers.add(connection);
  for (const chunk of session.buffer) {
    send(connection.socket, { type: "data", id, data: chunk.toString("base64") });
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
    send(connection.socket, { type: "error", request: type, message: "hello first" });
    return;
  }
  const id = typeof request.id === "string" ? request.id : undefined;
  switch (type) {
    case "hello": {
      if (request.token !== token) {
        send(connection.socket, { type: "error", request: type, message: "bad token" });
        connection.socket.end();
        return;
      }
      connection.authed = true;
      send(connection.socket, { type: "welcome", owner });
      return;
    }
    case "host.info":
      send(connection.socket, { type: "ok", request: type, owner });
      return;
    case "host.shutdown":
      send(connection.socket, { type: "ok", request: type });
      shutdown();
      return;
    case "session.open": {
      if (id === undefined) {
        send(connection.socket, { type: "error", request: type, message: "id required" });
        return;
      }
      const command = Array.isArray(request.command) ? (request.command as string[]) : ["/bin/sh"];
      const cols = typeof request.cols === "number" ? request.cols : 80;
      const rows = typeof request.rows === "number" ? request.rows : 24;
      const cwd = typeof request.cwd === "string" ? request.cwd : checkout;
      send(connection.socket, { type: "ok", request: type, ...openSession(id, cwd, command, cols, rows) });
      return;
    }
    case "session.attach": {
      if (id === undefined) return;
      send(connection.socket, { type: "ok", request: type, ...attach(connection, id) });
      return;
    }
    case "session.detach":
      if (id !== undefined) detach(connection, id);
      send(connection.socket, { type: "ok", request: type });
      return;
    case "session.write": {
      const session = id === undefined ? undefined : sessions.get(id);
      if (session && typeof request.data === "string") {
        session.pty.write(Buffer.from(request.data, "base64").toString("utf8"));
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
      send(connection.socket, { type: "ok", request: type });
      return;
    }
    default:
      send(connection.socket, { type: "error", request: type, message: `unknown request ${type}` });
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

writeFileSync(`${socketPath}.token`, token, { mode: 0o600 });
writeFileSync(`${socketPath}.pid`, String(process.pid), { mode: 0o600 });
writeFileSync(`${socketPath}.owner.json`, JSON.stringify(owner), { mode: 0o600 });

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

server.on("error", (e) => {
  console.error(`host: ${e.message}`);
  process.exit(1);
});

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  console.log(`host ${process.pid} listening on ${socketPath}`);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
