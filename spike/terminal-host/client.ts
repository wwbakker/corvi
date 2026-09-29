/**
 * The client helper: start a terminal host or adopt the one already running, then drive it.
 *
 * `ensureHost` is the interesting half. It reads the host's owner record and, when the record's
 * checkout path and build id match what this client expects, connects to the running host
 * instead of starting a new one. When they disagree — the host came from another checkout or
 * another build — the old host is shut down and a fresh one is started. When the record is
 * missing or its socket is dead, a fresh host is started.
 *
 * `HostClient` wraps one connection: request/response for control, and `onData`/`onExit` for the
 * streaming half. Detaching (`close`) leaves the host and every pty alive, which is what makes
 * adoption observable.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  private pending = new Map<string, ((value: Record<string, unknown>) => void)[]>();
  private readonly dataListeners = new Map<string, ((data: Buffer) => void)[]>();
  private readonly exitListeners = new Map<string, ((exitCode: number) => void)[]>();
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
      for (const listener of this.dataListeners.get(message.id) ?? []) listener(data);
      return;
    }
    if (message.type === "exit" && typeof message.id === "string") {
      const code = typeof message.exitCode === "number" ? message.exitCode : 0;
      for (const listener of this.exitListeners.get(message.id) ?? []) listener(code);
      return;
    }
    const request = typeof message.request === "string" ? message.request : "hello";
    const waiters = this.pending.get(request);
    const waiter = waiters?.shift();
    if (waiter) waiter(message);
  }

  private call(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = String(message.type);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const current = this.pending.get(request);
        if (current) this.pending.set(request, current.filter((w) => w !== done));
        reject(new Error(`host request timed out: ${request}`));
      }, 5000);
      const done = (value: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const waiters = this.pending.get(request) ?? [];
      waiters.push(done);
      this.pending.set(request, waiters);
      this.socket.write(`${JSON.stringify(message)}\n`);
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

  async attach(id: string): Promise<{ attached: boolean }> {
    const reply = await this.call({ type: "session.attach", id });
    return { attached: Boolean(reply.attached) };
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

/** Stop a host the client can no longer talk to: ask, then signal, then insist. */
const stopStale = async (socketPath: string): Promise<void> => {
  const owner = readOwner(socketPath);
  try {
    const client = await HostClient.connect(socketPath);
    await client.shutdown();
    client.close();
  } catch {
    // no handshake; fall through to signals
  }
  if (owner !== undefined && processAlive(owner.pid)) {
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

const hostScript = fileURLToPath(new URL("./host.ts", import.meta.url));

/** Start-or-adopt. The returned client is connected and handshaken; the caller owns whether it
 * closes (detach) or not (adopt). */
export const ensureHost = async (options: EnsureOptions): Promise<{ client: HostClient; adopted: boolean }> => {
  const existing = readOwner(options.socket);
  if (existing !== undefined && existsSync(options.socket)) {
    try {
      const client = await HostClient.connect(options.socket);
      const owner = await client.info();
      if (owner.checkout === options.checkout && owner.buildId === options.buildId) {
        return { client, adopted: true };
      }
      // Ownership disagrees: this host belongs to another build. Replace it.
      await client.shutdown().catch(() => undefined);
      client.close();
      await stopStale(options.socket);
    } catch {
      await stopStale(options.socket);
    }
    removeRecords(options.socket);
  }

  const env = { ...process.env };
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(
    process.execPath,
    [hostScript, "--socket", options.socket, "--checkout", options.checkout, "--build-id", options.buildId],
    { detached: true, stdio: "ignore", env },
  );
  child.unref();

  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(`${options.socket}.token`) && existsSync(options.socket)) {
      try {
        const client = await HostClient.connect(options.socket);
        await client.info();
        return { client, adopted: false };
      } catch {
        // still coming up
      }
    }
    if (Date.now() > deadline) throw new Error(`the host did not come up at ${options.socket}`);
    await sleep(25);
  }
};
