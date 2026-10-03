/**
 * The terminal-screen benchmark: how much CPU the server spends on the screens it owns, and how
 * that load affects the API.
 *
 * It starts a real server (Node, as the app does), opens N terminal windows each running a
 * continuously-updating full-screen loop, and samples the server's own CPU from
 * `/proc/<pid>/stat` while polling the read routes. `--profile` sends the server `SIGUSR1` and
 * runs a CPU profile over CDP (`Profiler.start`/`stop`) through the repo's `ws`, then prints the
 * hottest functions by self samples.
 *
 * Run: `bun scripts/bench-screens.ts [--sessions 4] [--attach 1] [--seconds 8] [--profile]`.
 * Everything lives in a temp dir and is removed at the end; the host is stopped with it.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { RawData } from "ws";

import { checkoutsOf, runSh, serverEnv, testRun, testTempDir, waitForUrl } from "../test/helpers.ts";

const require = createRequire(import.meta.url);
// `ws` is the server's own dependency; the benchmark speaks the same WebSocket to it and to the
// inspector, so it uses the same client.
const WebSocket = require("../apps/server/node_modules/ws/index.js") as typeof import("ws").default;

const flag = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const raw = at === -1 ? undefined : process.argv[at + 1];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const sessions = flag("sessions", 4);
const attached = flag("attach", 1);
const seconds = flag("seconds", 8);
const profile = has("profile");
const grace = flag("grace", 0);
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

const main = async (): Promise<void> => {
  // The run token names the temp dirs and the host, so `scripts/clean-test.ts` can sweep this.
  process.env.CORVI_TEST_RUN = process.env.CORVI_TEST_RUN ?? `${Date.now().toString(36)}.${process.pid.toString(36)}`;
  const tmp = await testTempDir("bench");
  const server = Bun.spawn(["node", "apps/server/src/server.ts"], {
    cwd: root,
    env: serverEnv(tmp, grace > 0 ? { CORVI_SCREEN_IDLE_MS: String(grace) } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const url = await waitForUrl(server);
    const pid = server.pid;
    const repo = join(tmp, "repo");
    await runSh(["git", "init", "-b", "main", repo]);
    await fetch(`${url}/api/changes`, {
      method: "POST",
      body: JSON.stringify({ id: "BENCH", checkouts: checkoutsOf([repo]) }),
    });

    const newWindow = async (): Promise<string> => {
      const response = await fetch(`${url}/api/changes/BENCH/terminal/windows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "new" }),
      });
      const windows = (await response.json()) as { id: string; activePane: string }[];
      return windows[windows.length - 1]!.activePane;
    };

    // Open every window and start its loop; keep `attached` sockets open as the viewed windows
    // (agents run unwatched, so the rest are closed after the command is sent).
    const panes: string[] = [];
    const sockets: InstanceType<typeof WebSocket>[] = [];
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
    await sleep(500); // let the loops start

    // Sample CPU and poll the read routes for the busy period; switch the viewed window
    // periodically, measuring the real cost (serialize the screen, send the snapshot).
    const samples: Sample[] = [{ at: Date.now(), ticks: cpuTicks(pid) }];
    const workspaces: number[] = [];
    const changes: number[] = [];
    const selects: number[] = [];
    const snapshots: number[] = [];
    const snapshotBytes: number[] = [];
    const switchTargets = panes.slice(attached);
    let switchAt = 0;
    let lastSwitch = Date.now();
    const deadline = Date.now() + seconds * 1000;
    let alternate = true;
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
      const started = Date.now();
      await fetch(`${url}/api/changes/BENCH/terminal/windows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "select", index: alternate ? 0 : panes.length - 1 }),
      }).then((r) => r.text());
      selects.push(Date.now() - started);
      alternate = !alternate;
      // A switch every 4s: the point is the flood, and re-attending a pane resets its unattended
      // clock, so switching constantly would hide the release it is meant to show.
      const target = Date.now() - lastSwitch >= 4000 ? switchTargets[switchAt++ % Math.max(1, switchTargets.length)] : undefined;
      lastSwitch = target === undefined ? lastSwitch : Date.now();
      if (target !== undefined) {
        const at = Date.now();
        let bytes = 0;
        const socket = await new Promise<InstanceType<typeof WebSocket>>((resolve) => {
          const candidate = new WebSocket(`${url.replace(/^http/, "ws")}/api/changes/BENCH/terminal/socket?cols=80&rows=24&session=${target}`);
          candidate.on("message", (raw: RawData, binary: boolean) => {
            if (binary) bytes += Buffer.isBuffer(raw) ? raw.length : raw instanceof ArrayBuffer ? raw.byteLength : 0;
            else {
              const frame = JSON.parse(raw.toString()) as { type?: string; data?: string };
              if (frame.type === "snapshot") bytes += (frame.data ?? "").length;
              if (frame.type === "snapshot" || frame.type === "reset") resolve(candidate);
            }
          });
        });
        snapshots.push(Date.now() - at);
        snapshotBytes.push(bytes);
        socket.close();
      }
      await sleep(100);
    }
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const wall = (last.at - first.at) / 1000;
    const cpu = wall === 0 ? 0 : ((last.ticks - first.ticks) / 100) / wall * 100;

    const line = (name: string, values: number[]): string =>
      `${name.padEnd(16)} p50=${percentile(values, 0.5).toString().padStart(4)}ms  p95=${percentile(values, 0.95)
        .toString()
        .padStart(4)}ms  max=${Math.max(0, ...values).toString().padStart(5)}ms`;
    console.log(`sessions=${sessions} attached=${attached} seconds=${seconds} grace=${grace || "default"}`);
    console.log(`server cpu      ${cpu.toFixed(1)}%  (${((last.ticks - first.ticks) / 100 / wall * 100).toFixed(1)}% utime+stime)`);
    console.log(line("/api/workspaces", workspaces));
    console.log(line("/api/changes", changes));
    console.log(line("window select", selects));
    console.log(line("window switch", snapshots));
    console.log(`snapshot bytes  p50=${percentile(snapshotBytes, 0.5)}  max=${Math.max(0, ...snapshotBytes)}`);
    if (profileTask !== undefined) console.log(await profileTask);

    for (const socket of sockets) socket.close();
    await fetch(`${url}/api/changes/BENCH/terminal/windows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", index: 0 }),
    }).catch(() => undefined);
  } finally {
    server.kill();
    await server.exited;
    // The host outlives the server by design; the test's own cleaner sweeps it by run token, but a
    // benchmark should leave nothing behind either.
    await runSh(["bun", "scripts/clean-test.ts", "--kill", "--prune"], root).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
};

await main();
