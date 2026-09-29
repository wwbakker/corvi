/**
 * A minimal server stand-in for the Phase 1 restart proof. It owns the registry the host
 * deliberately does not: which change/window each session id belongs to. Each phase is a
 * separate process, so "the server was SIGKILLed" is a real process death and the only thing
 * left holding the shells is the host.
 *
 *   node server.ts --phase a            --socket <p> --state <p> --cwd1 <p> --cwd2 <p> [--idle-ms N]
 *   node server.ts --phase inspect      --socket <p> [--idle-ms N]
 *   node server.ts --phase b            --socket <p> --state <p> [--idle-ms N]
 *   node server.ts --phase exit-detached --socket <p> [--idle-ms N]
 *   node server.ts --phase c-start      --socket <p> --cwd3 <p> [--idle-ms N]
 *   node server.ts --phase c-recover    --socket <p> [--idle-ms N]
 *
 * Every phase prints one `READY {json}` line. `a` and `c-start` then block so the driver can
 * SIGKILL them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ensureHost, type HostClient } from "../terminal-host/client.ts";

const argOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const phase = argOf("--phase");
const socket = argOf("--socket");
const statePath = argOf("--state");
const checkout = argOf("--checkout") ?? process.cwd();
const buildId = argOf("--build-id") ?? "v1";
const idleMs = Number(argOf("--idle-ms") ?? 0);
if (phase === undefined || socket === undefined) {
  console.error("usage: server.ts --phase <a|inspect|b|exit-detached|c-start|c-recover> --socket <path>");
  process.exit(2);
}

const options = { socket, checkout, buildId, ...(idleMs > 0 ? { idleMs } : {}) };
const output = new Map<string, string>();
const exits = new Map<string, number>();
let client: HostClient;

const subscribe = (ids: readonly string[]): void => {
  for (const id of ids) {
    output.set(id, "");
    client.onData(id, (data) => output.set(id, (output.get(id) ?? "") + data.toString("utf8")));
    client.onExit(id, (code) => exits.set(id, code));
  }
};

const waitFor = async (id: string, expected: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((output.get(id) ?? "").includes(expected)) return true;
    await sleep(20);
  }
  return false;
};

const ready = (result: Record<string, unknown>): void => {
  console.log(`READY ${JSON.stringify(result)}`);
};
const block = (): Promise<void> => new Promise<void>(() => {});
/** Short phases: print, drop the connection, flush stdout and exit. Without this the open socket
 * keeps the process (and its server stand-in) alive forever. */
const finish = async (): Promise<void> => {
  client.close();
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
};

const openShell = async (id: string, cwd: string): Promise<void> => {
  await client.open(id, { cwd, command: ["/bin/sh"], cols: 100, rows: 30 });
};

if (phase === "a") {
  const cwd1 = argOf("--cwd1") ?? process.cwd();
  const cwd2 = argOf("--cwd2") ?? process.cwd();
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["s1", "s2"]);
  await openShell("s1", cwd1);
  await openShell("s2", cwd2);
  await sleep(300);
  await client.attach("s1");
  await client.attach("s2");
  await sleep(200);
  client.write("s1", "echo A_$(( 0 + 1 ))_S1_MARK\n");
  client.write("s2", "echo A_$(( 0 + 1 ))_S2_MARK\n");
  const s1 = await waitFor("s1", "A_1_S1_MARK", 5000);
  const s2 = await waitFor("s2", "A_1_S2_MARK", 5000);
  if (!s1 || !s2) throw new Error(`markers did not arrive: s1=${s1} s2=${s2}`);
  if (statePath === undefined) throw new Error("phase a needs --state");
  writeFileSync(
    statePath,
    JSON.stringify([
      { id: "s1", change: "C1", window: "W1" },
      { id: "s2", change: "C2", window: "W2" },
    ]),
  );
  const info = await client.info();
  ready({ phase: "a", adopted, hostPid: info.pid, s1, s2 });
  await block();
} else if (phase === "inspect") {
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  const info = await client.info();
  const sessions = await client.list();
  ready({ phase: "inspect", adopted, hostPid: info.pid, sessions });
  await finish();
} else if (phase === "b") {
  if (statePath === undefined) throw new Error("phase b needs --state");
  const registry = JSON.parse(readFileSync(statePath, "utf8")) as {
    id: string;
    change: string;
    window: string;
  }[];
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  const sessions = await client.list();
  subscribe(registry.map((entry) => entry.id));
  const results: Record<string, unknown>[] = [];
  for (const entry of registry) {
    const found = sessions.find((session) => session.id === entry.id);
    const alive = found?.alive === true;
    await client.attach(entry.id);
    await sleep(200);
    const upper = entry.id.toUpperCase();
    client.write(entry.id, `echo B_$(( 0 + 1 ))_${upper}_MARK\n`);
    const newOk = await waitFor(entry.id, `B_1_${upper}_MARK`, 5000);
    const earlier = (output.get(entry.id) ?? "").includes(`A_1_${upper}_MARK`);
    results.push({ id: entry.id, change: entry.change, window: entry.window, alive, earlier, newOk });
  }
  const info = await client.info();
  ready({ phase: "b", adopted, hostPid: info.pid, results });
  await finish();
} else if (phase === "exit-detached") {
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["s2"]);
  // No attach to s2: an exit typed into a session nobody is watching must still be defined.
  client.write("s2", "exit\n");
  let dead = false;
  for (let i = 0; i < 100; i++) {
    const found = (await client.list()).find((session) => session.id === "s2");
    if (found !== undefined && !found.alive) {
      dead = true;
      break;
    }
    await sleep(50);
  }
  const reply = await client.attach("s2", 0);
  await sleep(200);
  const replayed = (output.get("s2") ?? "").includes("A_1_S2_MARK");
  // s1 was never attached here either; kill removes its record, leaving no live session.
  await client.kill("s1");
  const remaining = (await client.list()).map((session) => `${session.id}:${session.alive ? "alive" : "dead"}`);
  const info = await client.info();
  ready({
    phase: "exit-detached",
    adopted,
    hostPid: info.pid,
    s2Dead: dead,
    attachAlive: reply.alive,
    attachExitCode: reply.exitCode ?? null,
    exitEvent: exits.get("s2") ?? null,
    replayed,
    remaining,
  });
  await finish();
} else if (phase === "c-start") {
  const cwd3 = argOf("--cwd3") ?? process.cwd();
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["s3"]);
  await openShell("s3", cwd3);
  await sleep(300);
  await client.attach("s3");
  await sleep(200);
  client.write("s3", "echo C_$(( 0 + 1 ))_S3_MARK\n");
  const marker = await waitFor("s3", "C_1_S3_MARK", 5000);
  const sessions = await client.list();
  const info = await client.info();
  ready({ phase: "c-start", adopted, hostPid: info.pid, shellPid: sessions[0]?.pid ?? null, marker });
  await block();
} else if (phase === "c-recover") {
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  const info = await client.info();
  const sessions = await client.list();
  ready({ phase: "c-recover", adopted, hostPid: info.pid, sessionCount: sessions.length });
  await client.shutdown().catch(() => undefined);
  await finish();
} else {
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}
