/**
 * The warm-screen benchmark: how much memory and CPU N unviewed terminal screens cost, and what
 * the persistence cadence costs to serialize.
 *
 * It starts a real server (Node, as the app does), opens N terminal windows each running a
 * continuously-updating full-screen loop, then closes every page. The screens stay warm and
 * unviewed, exactly as an agent window does. It samples the server's CPU from `/proc/<pid>/stat`
 * and its RSS, polls the read routes, and reads the `CORVI_TERMINAL_TRACE` per-hub lines for the
 * screen estimates, persistence counters, and the first-view serve latency/bytes.
 * `--attach` keeps that many pages open for a viewed/unviewed comparison; the default measures
 * unviewed screens only.
 *
 * Run: `bun scripts/bench-screens.ts [--sessions 8] [--attach 0] [--seconds 8] [--cadence 1000]
 * [--trace-ms 1000] [--profile]`.
 * Everything lives in a temp dir and is removed at the end; the host is stopped with it. The
 * cadence/trace intervals are shortened from production (5 s) so one run observes several
 * persistence passes; `lastPersistMs` is the per-pass serialize cost and does not depend on the
 * interval.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RawData } from "ws";
import { testTempBase } from "./test-temp.ts";

const require = createRequire(import.meta.url);
// `ws` is the server's own dependency; the benchmark speaks the same WebSocket to it and to the
// inspector, so it uses the same client.
const WebSocket = require("../apps/server/node_modules/ws/index.js") as typeof import("ws").default;

/** A temp dir whose name says it is this benchmark's, so `clean-test` can sweep what it leaves.
 * Under the test temp base: its state holds the terminal host's unix socket, which must fit a
 * `sun_path` (scripts/test-temp.ts). */
const benchTempDir = (label: string): Promise<string> => mkdtemp(join(testTempBase(), `corvi-${label}-`));

/** The environment a spawned server gets: isolated roots in the temp dir, a random port. */
const serverEnv = (tmp: string, extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...process.env,
  CORVI_ROOT: join(tmp, "changes"),
  CORVI_ARCHIVE_ROOT: join(tmp, "changes-archive"),
  CORVI_CONFIG: join(tmp, "config.json"),
  XDG_STATE_HOME: join(tmp, "state"),
  CORVI_CACHE: join(tmp, "cache.json"),
  CORVI_PORT: "0",
  ...extra,
});

/** Read the server's startup line (`corvi on <url>`) and hand back the URL. */
const waitForUrl = async (proc: ReturnType<typeof Bun.spawn>, timeoutMs = 60_000): Promise<string> => {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the server did not come up within ${timeoutMs}ms:\n${seen}`)), timeoutMs);
  });
  const found = (async (): Promise<string> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the server exited before it was up:\n${seen}`);
      seen += decoder.decode(value, { stream: true });
      const match = /corvi on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(seen);
      if (match?.[1]) return match[1].replace(/\/$/, "");
    }
  })();
  try {
    return await Promise.race([found, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Run a command to completion, ignoring its output. */
const runSh = async (cmd: readonly string[], cwd?: string): Promise<void> => {
  await Bun.spawn([...cmd], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
};

/** The checkout specs that create a change in the benchmark repo. */
const checkoutsOf = (paths: readonly string[]): { path: string; location: "new"; branch: { kind: "change" } }[] =>
  paths.map((path) => ({ path, location: "new" as const, branch: { kind: "change" as const } }));

/** Stop the host the server started, by the pid it recorded. A benchmark must leave no host (and
 * no shell) behind: an `ensureHost().shutdown()` handshake can time out under its own flood, which
 * is how earlier runs leaked one host per run. */
const stopHost = (socket: string): void => {
  try {
    const pid = Number(readFileSync(`${socket}.pid`, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // already gone, or never started
  }
};

const flag = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const raw = at === -1 ? undefined : process.argv[at + 1];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const sessions = Math.max(1, flag("sessions", 8));
const attached = Math.max(0, Math.min(sessions, flag("attach", 0)));
const seconds = Math.max(1, flag("seconds", 8));
const cadenceMs = Math.max(100, flag("cadence", 1000));
const traceMs = Math.max(100, flag("trace-ms", 1000));
const profile = has("profile");
const root = process.cwd();

/** The redraw: clear, home, 40 rows of colour, ~20 times a second. A TUI-shaped load — cursor
 * addressing and SGR runs, not a growing scrollback — which is what pins the parser. */
const LOOP =
  `while :; do printf '\\033[2J\\033[H'; i=0; ` +
  `while [ $i -lt 24 ]; do printf '\\033[3%dm%-120s\\033[0m\\n' $((i % 8)) "row $i $RANDOM$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM"; ` +
  `i=$((i+1)); done; sleep 0.05; done`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** utime + stime in clock ticks (100/s on Linux). */
const cpuTicks = (pid: number): number => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(after[11]) + Number(after[12]);
  } catch {
    return 0;
  }
};

type Sample = { readonly at: number; readonly ticks: number };

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

/** A minimal CDP client over the repo's `ws`: request/response by id, events by method. */
const connectCdp = async (): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}> => {
  const list = (await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json())) as {
    webSocketDebuggerUrl?: string;
  }[];
  const url = list.find((entry) => entry.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  if (url === undefined) throw new Error("the inspector has no websocket debugger url");
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  socket.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
};

type CdpNode = {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly hitCount?: number;
};

/** The hottest functions by self samples, with the sampling interval turned back into ms. */
const profileFor = async (durationMs: number): Promise<string> => {
  const cdp = await connectCdp();
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await sleep(durationMs);
  const result = await cdp.send("Profiler.stop");
  cdp.close();
  const profile = (result.result as { profile?: { nodes?: CdpNode[] } } | undefined)?.profile;
  const nodes = profile?.nodes ?? [];
  const hits = new Map<string, number>();
  for (const node of nodes) {
    const name = `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`;
    hits.set(name, (hits.get(name) ?? 0) + (node.hitCount ?? 0));
  }
  const total = [...hits.values()].reduce((sum, value) => sum + value, 0);
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return [
    `profile: ${total} samples over ${durationMs}ms (self time, ~0.2ms each)`,
    ...top.map(([name, count]) => `  ${String((count / total) * 100).padStart(5)}%  ${String(count).padStart(6)}  ${name}`),
  ].join("\n");
};

type ScreenTrace = {
  readonly key: string;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly bufferRows: number;
  readonly scrollbackRows: number;
  readonly estBytes: number;
  readonly attached: number;
  readonly subscribers: number;
  readonly serializedBytes: number;
  readonly persists: number;
  readonly lastPersistMs: number;
  readonly reprinting: number;
};

const TRACE_SCREEN =
  /\[terminals\] screen (\S+) grid=(\d+)x(\d+) bufferRows=(\d+) scrollbackRows=(\d+) estBytes=(\d+) attached=(\d+) subscribers=(\d+) serializedBytes=(\d+) persists=(\d+) lastPersistMs=(\d+) reprinting=(\d+)/;

/** The latest per-hub trace line in the log, keyed by `sessionId#incarnation`. */
const parseTrace = (text: string): Map<string, ScreenTrace> => {
  const screens = new Map<string, ScreenTrace>();
  for (const line of text.split("\n")) {
    const match = TRACE_SCREEN.exec(line);
    if (match === null) continue;
    const [, key, cols, rows, bufferRows, scrollbackRows, estBytes, attachedCount, subscribers, serializedBytes, persists, lastPersistMs, reprinting] = match;
    screens.set(key!, {
      key: key!,
      gridCols: Number(cols),
      gridRows: Number(rows),
      bufferRows: Number(bufferRows),
      scrollbackRows: Number(scrollbackRows),
      estBytes: Number(estBytes),
      attached: Number(attachedCount),
      subscribers: Number(subscribers),
      serializedBytes: Number(serializedBytes),
      persists: Number(persists),
      lastPersistMs: Number(lastPersistMs),
      reprinting: Number(reprinting),
    });
  }
  return screens;
};

type ServedTrace = { readonly key: string; readonly bytes: number; readonly ms: number };

const TRACE_SERVED = /\[terminals\] served (\S+) offset=\d+ bytes=(\d+) \((\d+) ms\)/;

/** The `served ... (N ms)` trace lines, in order. */
const parseServed = (text: string): ServedTrace[] => {
  const served: ServedTrace[] = [];
  for (const line of text.split("\n")) {
    const match = TRACE_SERVED.exec(line);
    if (match === null) continue;
    served.push({ key: match[1]!, bytes: Number(match[2]), ms: Number(match[3]) });
  }
  return served;
};

/** The server's resident set size in kB, or 0 when the process is gone. */
const rssKb = (pid: number): number => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+) kB/m.exec(status);
    return Number(match?.[1] ?? 0);
  } catch {
    return 0;
  }
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : sum(values) / values.length);
const maxOf = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.max(...values));
const mib = (kb: number): string => (kb / 1024).toFixed(1);
const mibFromBytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

const main = async (): Promise<void> => {
  // The run token names the temp dirs and the host, so `scripts/clean-test.ts` can sweep this.
  process.env.CORVI_TEST_RUN = process.env.CORVI_TEST_RUN ?? `${Date.now().toString(36)}.${process.pid.toString(36)}`;
  const tmp = await benchTempDir("bench");
  const traceLog = join(tmp, "terminal-trace.log");
  const server = Bun.spawn(["node", "apps/server/src/server.ts"], {
    cwd: root,
    env: serverEnv(tmp, {
      CORVI_TERMINAL_TRACE: "1",
      CORVI_TERMINAL_TRACE_MS: String(traceMs),
      CORVI_LOG: traceLog,
      CORVI_SCREEN_CADENCE_MS: String(cadenceMs),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  try {
    const url = await waitForUrl(server);
    const pid = server.pid;
    const repo = join(tmp, "repo");
    await runSh(["git", "init", "-b", "main", repo]);
    await fetch(`${url}/api/changes`, {
      method: "POST",
      body: JSON.stringify({ id: "BENCH", checkouts: checkoutsOf([repo]) }),
    });
    const rssBase = rssKb(pid);

    const newWindow = async (): Promise<string> => {
      const response = await fetch(`${url}/api/changes/BENCH/terminal/windows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "new" }),
      });
      const windows = (await response.json()) as { id: string; activePane: string }[];
      return windows[windows.length - 1]!.activePane;
    };

    // Open every window and start its loop. Keep `attached` sockets as viewed screens; close the
    // rest so the remainder are warm and unviewed, which is the case this benchmark measures.
    const panes: string[] = [];
    const open = (pane: string): Promise<InstanceType<typeof WebSocket>> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${url.replace(/^http/, "ws")}/api/changes/BENCH/terminal/socket?cols=80&rows=24&session=${pane}`);
        socket.on("message", (raw: RawData, binary: boolean) => {
          if (!binary) {
            const frame = JSON.parse(raw.toString()) as { type?: string };
            if (frame.type === "snapshot" || frame.type === "reset") resolve(socket);
          }
        });
        socket.on("error", reject);
      });
    const probe = (pane: string): Promise<{ readonly latencyMs: number; readonly snapshotBytes: number }> =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        let bytes = 0;
        const socket = new WebSocket(`${url.replace(/^http/, "ws")}/api/changes/BENCH/terminal/socket?cols=80&rows=24&session=${pane}`);
        socket.on("message", (raw: RawData, binary: boolean) => {
          if (binary) {
            bytes += Buffer.isBuffer(raw) ? raw.length : raw instanceof ArrayBuffer ? raw.byteLength : 0;
            return;
          }
          const frame = JSON.parse(raw.toString()) as { type?: string; data?: string };
          if (frame.type === "snapshot") bytes += (frame.data ?? "").length;
          if (frame.type === "snapshot" || frame.type === "reset") {
            socket.close();
            resolve({ latencyMs: Date.now() - started, snapshotBytes: bytes });
          }
        });
        socket.on("error", reject);
      });
    for (let index = 0; index < sessions; index++) {
      const pane = await newWindow();
      panes.push(pane);
      const socket = await open(pane);
      socket.send(Buffer.from(LOOP + "\n"));
      if (index < attached) sockets.push(socket);
      else {
        await sleep(50);
        socket.close();
      }
    }
    await sleep(1000); // let the loops start and the first trace line appear

    const traceText = (): string => {
      try {
        return readFileSync(traceLog, "utf8");
      } catch {
        return "";
      }
    };
    const waitForScreens = async (wanted: number): Promise<Map<string, ScreenTrace>> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const screens = parseTrace(traceText());
        if (screens.size >= wanted || Date.now() >= deadline) return screens;
        await sleep(200);
      }
    };
    await waitForScreens(sessions);
    const traceStart = parseTrace(traceText());
    const rssStart = rssKb(pid);

    // Sample CPU, RSS, the read routes, and the trace counters over the steady-state period.
    const samples: Sample[] = [{ at: Date.now(), ticks: cpuTicks(pid) }];
    const workspaces: number[] = [];
    const changes: number[] = [];
    const deadline = Date.now() + seconds * 1000;
    const latency = async (path: string, into: number[]): Promise<void> => {
      const started = Date.now();
      await fetch(`${url}${path}`).then((r) => r.text());
      into.push(Date.now() - started);
    };
    let profileTask: Promise<string> | undefined;
    if (profile) {
      process.kill(pid, "SIGUSR1");
      await sleep(500); // let the inspector come up
      profileTask = profileFor(Math.min(seconds, 6) * 1000);
    }
    while (Date.now() < deadline) {
      samples.push({ at: Date.now(), ticks: cpuTicks(pid) });
      await latency("/api/workspaces", workspaces);
      await latency("/api/changes", changes);
      await sleep(100);
    }
    await sleep(Math.min(1500, traceMs + 250));
    const traceEnd = parseTrace(traceText());
    const rssEnd = rssKb(pid);

    // First view of an unviewed warm screen: the click-to-working path. The wall time is the
    // socket/snapshot round trip; the trace's `served ... (N ms)` is the server's serialize/send
    // time. Leave the screens unviewed again by closing the probe sockets.
    const servedBefore = parseServed(traceText()).length;
    const firstViews: { readonly latencyMs: number; readonly snapshotBytes: number }[] = [];
    for (const pane of panes.slice(attached)) firstViews.push(await probe(pane));
    await sleep(200); // let the last `served` trace line reach the log
    const served = parseServed(traceText()).slice(servedBefore);

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const wall = (last.at - first.at) / 1000;
    const cpu = wall === 0 ? 0 : ((last.ticks - first.ticks) / 100) / wall * 100;
    const screens = [...traceEnd.values()];
    const unviewed = screens.filter((screen) => screen.subscribers === 0).length;
    const viewed = screens.length - unviewed;
    const persistCounts = screens.map((screen) =>
      Math.max(0, screen.persists - (traceStart.get(screen.key)?.persists ?? 0)),
    );
    const line = (name: string, values: number[]): string =>
      `${name.padEnd(20)} p50=${percentile(values, 0.5).toString().padStart(4)}ms  p95=${percentile(values, 0.95)
        .toString()
        .padStart(4)}ms  max=${Math.max(0, ...values).toString().padStart(5)}ms`;

    const servedBytes = served.length > 0 ? served.map((entry) => entry.bytes) : firstViews.map((entry) => entry.snapshotBytes);
    const servedMs = served.map((entry) => entry.ms);
    const hostRingMiB = sessions * 4;

    console.log(
      `sessions=${sessions} unviewed=${unviewed} viewed=${viewed} attached=${attached} seconds=${seconds} cadence=${cadenceMs}ms trace=${traceMs}ms`,
    );
    console.log(
      `server cpu       ${cpu.toFixed(1)}%  (${((last.ticks - first.ticks) / 100 / wall * 100).toFixed(1)}% utime+stime; worst case: synthetic TUI plus shortened cadence)`,
    );
    console.log(
      `server rss       base=${mib(rssBase)} MiB  start=${mib(rssStart)} MiB  end=${mib(rssEnd)} MiB  growth=${mib(rssEnd - rssStart)} MiB (server only; measured window, includes scrollback fill, not per-open allocation)`,
    );
    console.log(
      `host ring bound  ${sessions} x 4 MiB = ${hostRingMiB} MiB (per-live-session replay buffers; pty process RSS not sampled)`,
    );
    console.log(
      `screen estimates  hubs=${screens.length}  total=${mibFromBytes(sum(screens.map((screen) => screen.estBytes)))} MiB  avg=${mibFromBytes(mean(screens.map((screen) => screen.estBytes)))} MiB  max=${mibFromBytes(maxOf(screens.map((screen) => screen.estBytes)))} MiB`,
    );
    console.log(
      `buffer rows       avg=${mean(screens.map((screen) => screen.bufferRows)).toFixed(0)}  max=${maxOf(screens.map((screen) => screen.bufferRows))}  scrollback avg=${mean(screens.map((screen) => screen.scrollbackRows)).toFixed(0)}  max=${maxOf(screens.map((screen) => screen.scrollbackRows))}`,
    );
    console.log(
      `cadence           persists=${sum(persistCounts)} in ${seconds}s (${(sum(persistCounts) / seconds).toFixed(1)}/s)  lastPersistMs avg=${mean(screens.map((screen) => screen.lastPersistMs)).toFixed(1)}  max=${maxOf(screens.map((screen) => screen.lastPersistMs))}  serializedBytes avg=${Math.round(mean(screens.map((screen) => screen.serializedBytes)))}  max=${maxOf(screens.map((screen) => screen.serializedBytes))}`,
    );
    console.log(
      `first view        n=${firstViews.length} wall p50=${percentile(firstViews.map((entry) => entry.latencyMs), 0.5)}ms p95=${percentile(firstViews.map((entry) => entry.latencyMs), 0.95)}ms | server p50=${percentile(servedMs, 0.5)}ms p95=${percentile(servedMs, 0.95)}ms | snapshot bytes p50=${percentile(servedBytes, 0.5)} max=${maxOf(servedBytes)}`,
    );
    console.log(line("/api/workspaces", workspaces));
    console.log(line("/api/changes", changes));
    if (profileTask !== undefined) console.log(await profileTask);

    for (const socket of sockets) socket.close();
  } finally {
    server.kill();
    await server.exited;
    // The host outlives the server by design; stop it by pid, then remove the temp dir.
    stopHost(join(tmp, "state", "corvi", "host.sock"));
    await rm(tmp, { recursive: true, force: true });
  }
};

await main();
