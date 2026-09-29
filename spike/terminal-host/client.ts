/**
 * The client helper: start a terminal host or adopt the one already running, then drive it.
 *
 * `ensureHost` is the interesting half. It reads the host's owner record and, when the record's
 * checkout path, build id and protocol match what this client expects, connects to the running
 * host instead of starting a new one. A *real* mismatch — different checkout, build or protocol —
 * replaces the old host. A *transient* failure (connection refused, handshake or info timeout)
 * is retried with backoff and never turns into a signal to a possibly-live host; only files whose
 * pid is not a verified live host are unlinked.
 *
 * Check-and-spawn is serialized with an exclusive `<socket>.lock` (O_CREAT|O_EXCL), so two
 * clients starting at once cannot both spawn a host. Before any pid is signalled, `stopStale`
 * verifies it is the host (on Linux, `/proc/<pid>/cmdline` names this host script and socket).
 *
 * `HostClient` wraps one connection: request/response matched by `requestId`, and `onData`/
 * `onExit` for the streaming half. Data events carry a byte `seq`, and `attach` sends the offset
 * the client already has, so a reconnect does not duplicate output. Detaching (`close`) leaves
 * the host and every pty alive, which is what makes adoption observable.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Must equal the host's protocol constant. */
export const PROTOCOL = 1;

export type HostOwner = {
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

export type EnsureOptions = {
  readonly socket: string;
  readonly checkout: string;
  readonly buildId: string;
  /** Idle shutdown passed to a host this client starts; omitted or 0 disables it. */
  readonly idleMs?: number;
};

export type SessionInfo = {
  readonly id: string;
  readonly cwd: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly alive: boolean;
  readonly lastSeq: number;
  readonly exitCode?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class HostClient {
  private readonly socket: Socket;
  private nextId = 0;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  private readonly dataListeners = new Map<string, ((data: Buffer) => void)[]>();
  private readonly exitListeners = new Map<string, ((exitCode: number) => void)[]>();
  /** Highest byte offset received per session: what `attach` asks the host to resume from. */
  private readonly received = new Map<string, number>();
  private buffer = "";

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message.type === "data" && typeof message.id === "string" && typeof message.data === "string") {
      const data = Buffer.from(message.data, "base64");
      const seq = typeof message.seq === "number" ? message.seq : 0;
      this.received.set(message.id, Math.max(this.received.get(message.id) ?? 0, seq + data.length));
      for (const listener of this.dataListeners.get(message.id) ?? []) listener(data);
      return;
    }
    if (message.type === "exit" && typeof message.id === "string") {
      const code = typeof message.exitCode === "number" ? message.exitCode : 0;
      for (const listener of this.exitListeners.get(message.id) ?? []) listener(code);
      return;
    }
    if (typeof message.requestId === "number") {
      const waiter = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      waiter?.(message);
    }
  }

  private call(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`host request timed out: ${String(message.type)}`));
      }, 5000);
      this.pending.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.socket.write(`${JSON.stringify({ ...message, requestId })}\n`);
    });
  }

  private send(message: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  async info(): Promise<HostOwner> {
    const reply = await this.call({ type: "host.info" });
    return reply.owner as HostOwner;
  }

  async open(
    id: string,
    options: { cwd: string; command?: string[]; cols?: number; rows?: number },
  ): Promise<{ opened: boolean }> {
    const reply = await this.call({
      type: "session.open",
      id,
      cwd: options.cwd,
      command: options.command,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });
    return { opened: Boolean(reply.opened) };
  }

  /** Attach, resuming from `since` (default: the highest offset this connection has seen). The
   * reply states the session's final state, so a dead session's snapshot is not mistaken for a
   * live one. */
  async attach(id: string, since?: number): Promise<{ attached: boolean; alive: boolean; exitCode?: number }> {
    const from = since ?? this.received.get(id) ?? 0;
    const reply = await this.call({ type: "session.attach", id, since: from });
    return {
      attached: Boolean(reply.attached),
      alive: Boolean(reply.alive),
      ...(typeof reply.exitCode === "number" ? { exitCode: reply.exitCode } : {}),
    };
  }

  /** Every session the host retains, live or dead, with the metadata a restarting server needs to
   * re-associate its registry. */
  async list(): Promise<SessionInfo[]> {
    const reply = await this.call({ type: "session.list" });
    return (reply.sessions as SessionInfo[]) ?? [];
  }

  async detach(id: string): Promise<void> {
    await this.call({ type: "session.detach", id });
  }

  write(id: string, data: string): void {
    this.send({ type: "session.write", id, data: Buffer.from(data, "utf8").toString("base64") });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: "session.resize", id, cols, rows });
  }

  async kill(id: string): Promise<void> {
    await this.call({ type: "session.kill", id });
  }

  onData(id: string, listener: (data: Buffer) => void): void {
    const listeners = this.dataListeners.get(id) ?? [];
    listeners.push(listener);
    this.dataListeners.set(id, listeners);
  }

  onExit(id: string, listener: (exitCode: number) => void): void {
    const listeners = this.exitListeners.get(id) ?? [];
    listeners.push(listener);
    this.exitListeners.set(id, listeners);
  }

  close(): void {
    this.socket.destroy();
  }

  async shutdown(): Promise<void> {
    await this.call({ type: "host.shutdown" });
  }

  static async connect(socketPath: string): Promise<HostClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(socketPath);
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", reject);
    });
    const client = new HostClient(socket);
    const token = readFileSync(`${socketPath}.token`, "utf8").trim();
    const reply = await client.call({ type: "hello", token });
    if (reply.type === "error") {
      client.close();
      throw new Error(`host refused the handshake: ${String(reply.message)}`);
    }
    return client;
  }
}

const hostScript = fileURLToPath(new URL("./host.ts", import.meta.url));

/** Read the owner record, whether or not the process is still there. */
const readOwner = (socketPath: string): HostOwner | undefined => {
  const path = `${socketPath}.owner.json`;
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HostOwner;
  } catch {
    return undefined;
  }
};

const removeRecords = (socketPath: string): void => {
  for (const path of [`${socketPath}.token`, `${socketPath}.pid`, `${socketPath}.owner.json`, socketPath]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
};

/** Is `pid` the host for this socket? On Linux the command line is the proof. Off Linux (macOS)
 * we cannot read a command line portably here, so we only accept a live pid whose owner record
 * predates now — the weak check the reviewers allowed, and a spot for a `ps -o` follow-up. */
const verifiedHostPid = (owner: HostOwner, socketPath: string): boolean => {
  if (!processAlive(owner.pid)) return false;
  if (process.platform === "linux") {
    try {
      const cmdline = readFileSync(`/proc/${owner.pid}/cmdline`, "utf8");
      return cmdline.includes(hostScript) && cmdline.includes(socketPath);
    } catch {
      return false;
    }
  }
  const started = Date.parse(owner.startedAt);
  return Number.isFinite(started) && started <= Date.now();
};

/** Stop a host the client can no longer talk to. The graceful path is authenticated; the signal
 * path only ever touches a pid `verifiedHostPid` accepts. */
const stopStale = async (socketPath: string): Promise<void> => {
  const owner = readOwner(socketPath);
  try {
    const client = await HostClient.connect(socketPath);
    await client.shutdown();
    client.close();
  } catch {
    // no handshake; fall through to signals
  }
  if (owner !== undefined && verifiedHostPid(owner, socketPath)) {
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch {
      // gone
    }
    for (let i = 0; i < 50 && processAlive(owner.pid); i++) await sleep(20);
    if (processAlive(owner.pid)) {
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
};

const retire = async (client: HostClient | undefined, socketPath: string): Promise<void> => {
  if (client) {
    await client.shutdown().catch(() => undefined);
    client.close();
  }
  await stopStale(socketPath);
  removeRecords(socketPath);
};

type Inspection =
  | { readonly kind: "none" }
  | { readonly kind: "transient"; readonly error: string }
  | { readonly kind: "host"; readonly client: HostClient; readonly owner: HostOwner };

const inspect = async (socketPath: string): Promise<Inspection> => {
  if (!existsSync(socketPath)) {
    // An owner record without a socket is a dead host's leftovers; both `none` and the missing
    // socket fall through to cleanup/start in ensureHost.
    return { kind: "none" };
  }
  try {
    const client = await HostClient.connect(socketPath);
    const owner = await client.info();
    return { kind: "host", client, owner };
  } catch (e) {
    return { kind: "transient", error: e instanceof Error ? e.message : String(e) };
  }
};

const sameOwner = (owner: HostOwner, options: EnsureOptions): boolean =>
  owner.checkout === options.checkout && owner.buildId === options.buildId && owner.protocol === PROTOCOL;

/** Serialize check-and-spawn across processes. A lock left by a dead process is reclaimed. */
const withLock = async <T>(socketPath: string, body: () => Promise<T>): Promise<T> => {
  const lockPath = `${socketPath}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      try {
        return await body();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        // vanished between open and read
      }
      if (!Number.isFinite(holder) || !processAlive(holder)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // someone else got it
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`the lock at ${lockPath} is held by pid ${holder}`);
      await sleep(50);
    }
  }
};

const spawnHost = async (options: EnsureOptions, depth = 0): Promise<{ client: HostClient; adopted: boolean }> => {
  if (depth > 2) throw new Error(`could not start a host of our own at ${options.socket}`);
  const env = { ...process.env };
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(
    process.execPath,
    [
      hostScript,
      "--socket", options.socket,
      "--checkout", options.checkout,
      "--build-id", options.buildId,
      ...(options.idleMs !== undefined && options.idleMs > 0 ? ["--idle-ms", String(options.idleMs)] : []),
    ],
    { detached: true, stdio: "ignore", env },
  );
  child.unref();

  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(`${options.socket}.token`) && existsSync(options.socket)) {
      try {
        const client = await HostClient.connect(options.socket);
        const owner = await client.info();
        if (sameOwner(owner, options)) return { client, adopted: false };
        // A racing host with different ownership won the bind: replace it and start ours.
        await retire(client, options.socket);
        return spawnHost(options, depth + 1);
      } catch {
        // still coming up
      }
    }
    if (Date.now() > deadline) throw new Error(`the host did not come up at ${options.socket}`);
    await sleep(25);
  }
};

const ensureUnlocked = async (options: EnsureOptions): Promise<{ client: HostClient; adopted: boolean }> => {
  const first = await inspect(options.socket);
  if (first.kind === "host") {
    if (sameOwner(first.owner, options)) return { client: first.client, adopted: true };
    // Ownership disagrees: this host belongs to another build or checkout. Replace it.
    await retire(first.client, options.socket);
  } else if (first.kind === "transient") {
    // A transient failure is never a reason to signal a pid. Retry; only unlink records when no
    // verified live host owns them.
    const owner = readOwner(options.socket);
    const verified = owner !== undefined && verifiedHostPid(owner, options.socket);
    const deadline = Date.now() + (verified ? 5000 : 1000);
    for (;;) {
      await sleep(100);
      const again = await inspect(options.socket);
      if (again.kind === "host") {
        if (sameOwner(again.owner, options)) return { client: again.client, adopted: true };
        await retire(again.client, options.socket);
        break;
      }
      if (again.kind === "none") break;
      if (Date.now() > deadline) {
        if (!verified) {
          removeRecords(options.socket);
          break;
        }
        throw new Error(`a live host holds ${options.socket} but did not answer: ${first.error}`);
      }
    }
  }
  return spawnHost(options);
};

/** Start-or-adopt, serialized across processes. The returned client is connected and handshaken;
 * the caller owns whether it closes (detach) or not (adopt). */
export const ensureHost = async (options: EnsureOptions): Promise<{ client: HostClient; adopted: boolean }> =>
  withLock(options.socket, () => ensureUnlocked(options));
