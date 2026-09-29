/**
 * A minimal server stand-in for the Phase 1 restart proof. It owns the registry the host
 * deliberately does not: which change/window each session id belongs to. Each phase is a
 * separate process, so "the server was SIGKILLed" is a real process death and the only thing
 * left holding the shells is the host.
 *
 *   node server.ts --phase a             --socket <p> --state <p> --cwd1 <p> --cwd2 <p>
 *   node server.ts --phase inspect       --socket <p>
 *   node server.ts --phase b             --socket <p> --state <p>
 *   node server.ts --phase kill-reopen   --socket <p> --cwd <p>
 *   node server.ts --phase truncate      --socket <p> --cwd <p>
 *   node server.ts --phase exit-detached --socket <p>
 *   node server.ts --phase c-start       --socket <p> --cwd3 <p>
 *   node server.ts --phase c-recover     --socket <p>
 *   node server.ts --phase hup-start     --socket <p> --cwd <p>
 *
 * Every phase prints one `READY {json}` line. `a`, `c-start` and `hup-start` then block so the
 * driver can SIGKILL them (or their host).
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
  console.error("usage: server.ts --phase <a|inspect|b|kill-reopen|truncate|exit-detached|c-start|c-recover|hup-start> --socket <path>");
  process.exit(2);
}

const options = { socket, checkout, buildId, ...(idleMs > 0 ? { idleMs } : {}) };
const output = new Map<string, string>();
const exits = new Map<string, { code: number; signal: number }>();
let client: HostClient;

const subscribe = (ids: readonly string[]): void => {
  for (const id of ids) {
    output.set(id, "");
    client.onData(id, (data) => output.set(id, (output.get(id) ?? "") + data.toString("utf8")));
    client.onExit(id, (code, signal) => exits.set(id, { code, signal }));
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

const openShell = async (id: string, cwd: string, command: string[] = ["/bin/sh"]): Promise<number> => {
  const result = await client.open(id, { cwd, command, cols: 100, rows: 30 });
  return result.incarnation;
};

const waitDead = async (id: string): Promise<boolean> => {
  for (let i = 0; i < 200; i++) {
    const found = (await client.list()).find((session) => session.id === id);
    if (found !== undefined && !found.alive) return true;
    await sleep(25);
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
  subscribe(registry.map((entry) => entry.id));
  const results: Record<string, unknown>[] = [];
  for (const entry of registry) {
    // The attach reply is the source of truth for state; session.list could be a moment stale.
    const reply = await client.attach(entry.id);
    await sleep(200);
    const upper = entry.id.toUpperCase();
    client.write(entry.id, `echo B_$(( 0 + 1 ))_${upper}_MARK\n`);
    const newOk = await waitFor(entry.id, `B_1_${upper}_MARK`, 5000);
    const earlier = (output.get(entry.id) ?? "").includes(`A_1_${upper}_MARK`);
    results.push({
      id: entry.id,
      change: entry.change,
      window: entry.window,
      alive: reply.alive,
      exitCode: reply.exitCode ?? null,
      earlier,
      newOk,
    });
  }
  const info = await client.info();
  ready({ phase: "b", adopted, hostPid: info.pid, results });
  await finish();
} else if (phase === "kill-reopen") {
  const cwd = argOf("--cwd") ?? process.cwd();
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["s4"]);
  const events: { kind: string; incarnation: number; signal?: number }[] = [];
  client.onData("s4", (_data, incarnation) => events.push({ kind: "data", incarnation }));
  client.onExit("s4", (_code, signal, incarnation) => events.push({ kind: "exit", incarnation, signal }));
  const oldInc = await openShell("s4", cwd);
  const oldPid = (await client.list()).find((session) => session.id === "s4")?.pid ?? null;
  await sleep(300);
  await client.attach("s4");
  await sleep(200);
  await client.write("s4", "echo K_$(( 0 + 1 ))_S4_MARK\n");
  const marked = await waitFor("s4", "K_1_S4_MARK", 5000);
  await client.kill("s4");
  for (let i = 0; i < 200 && !events.some((e) => e.kind === "exit" && e.incarnation === oldInc); i++) await sleep(25);
  const oldExit = events.find((e) => e.kind === "exit" && e.incarnation === oldInc);
  // Reopen the retained dead id; a new incarnation must appear and the old pty must go quiet.
  const newInc = await openShell("s4", cwd);
  const newPid = (await client.list()).find((session) => session.id === "s4")?.pid ?? null;
  const atReopen = events.length;
  await sleep(400);
  await client.attach("s4");
  await sleep(200);
  await client.write("s4", "echo K2_$(( 0 + 1 ))_S4_MARK\n");
  const marked2 = await waitFor("s4", "K2_1_S4_MARK", 5000);
  const staleAfterReopen = events.slice(atReopen).filter((e) => e.incarnation === oldInc).length;
  ready({
    phase: "kill-reopen",
    adopted,
    oldInc,
    newInc,
    oldPid,
    newPid,
    marked,
    marked2,
    oldExitSignal: oldExit?.signal ?? null,
    staleAfterReopen,
    newData: events.some((e) => e.kind === "data" && e.incarnation === newInc),
  });
  await client.kill("s4");
  await finish();
} else if (phase === "truncate") {
  const cwd = argOf("--cwd") ?? process.cwd();
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["s5"]);
  await openShell("s5", cwd);
  const shellPid = (await client.list()).find((session) => session.id === "s5")?.pid ?? null;
  await sleep(300);
  await client.attach("s5");
  await sleep(200);
  client.write("s5", "head -c 300000 /dev/zero | tr '\\0' x; echo T_$(( 0 + 1 ))_DONE\n");
  const done = await waitFor("s5", "T_1_DONE", 20_000);
  const reply = await client.attach("s5", 0);
  ready({
    phase: "truncate",
    adopted,
    done,
    truncated: reply.truncated,
    oldestSeq: reply.oldestSeq,
    incarnation: reply.incarnation,
    shellPid,
  });
  await client.kill("s5");
  await finish();
} else if (phase === "exit-detached") {
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["s2"]);
  // No attach to s2: an exit typed into a session nobody is watching must still be defined.
  client.write("s2", "exit\n");
  const s2Dead = await waitDead("s2");
  const reply = await client.attach("s2", 0);
  await sleep(200);
  const replayed = (output.get("s2") ?? "").includes("A_1_S2_MARK");
  // s1 was never attached here either; kill retains it as dead like any other exit.
  await client.kill("s1");
  await waitDead("s1");
  const remaining = (await client.list()).map((session) => `${session.id}:${session.alive ? "alive" : "dead"}`);
  const info = await client.info();
  ready({
    phase: "exit-detached",
    adopted,
    hostPid: info.pid,
    s2Dead,
    attachAlive: reply.alive,
    attachExitCode: reply.exitCode ?? null,
    attachSignal: reply.signal ?? 0,
    exitEvent: exits.get("s2")?.code ?? null,
    exitSignal: exits.get("s2")?.signal ?? null,
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
} else if (phase === "hup-start") {
  const cwd = argOf("--cwd") ?? process.cwd();
  const { client: host, adopted } = await ensureHost(options);
  client = host;
  subscribe(["sH"]);
  // A child that ignores SIGHUP is not reached by the host's death closing the pty master.
  await openShell("sH", cwd, ["/bin/sh", "-c", "trap '' HUP; sleep 300"]);
  await sleep(400);
  const sessions = await client.list();
  const info = await client.info();
  ready({ phase: "hup-start", adopted, hostPid: info.pid, shellPid: sessions[0]?.pid ?? null });
  await block();
} else {
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}
