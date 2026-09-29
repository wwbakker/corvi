/**
 * A small, reproducible baseline of the terminal path Corvi ships today: node-pty spawning a
 * tmux client that attaches a tmux session, with the real server in the middle for the RSS
 * number.
 *
 * Run on Node (node-pty delivers no output on Bun):
 *
 *   node spike/baseline/baseline.ts
 *
 * Everything is isolated: a private tmux server on this run's own unix socket (never `-L corvi`,
 * never the user's socket; `$TMUX` is deleted and beaten by `-S`), and CORVI_ROOT / config /
 * cache / XDG_STATE_HOME under one temp dir. Nothing outside that dir is written.
 *
 * Part A measures the data plane directly (node-pty -> tmux attach): input round-trip and
 * output-flood throughput. Part B starts the real server, creates a change, attaches one
 * terminal over the WebSocket the page uses, and reports the server's RSS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNodePty, type IPty } from "../terminal-host/pty.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const loaded = loadNodePty();
if ("error" in loaded) throw new Error(`cannot load node-pty: ${loaded.error}`);
const pty = loaded.module;

const tmp = mkdtempSync(join(tmpdir(), "corvi-spike-baseline-"));
delete process.env.TMUX;
const tmuxSocket = join(tmp, "tmux.sock");

const tmux = (args: string[]): void => {
  const result = spawn("tmux", ["-S", tmuxSocket, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdio: "ignore",
  });
  result.unref();
};

/** Wait for `text` in an accumulating pty output, up to `timeoutMs`. */
const waitFor = (state: { output: string }, text: string, timeoutMs: number): Promise<number | undefined> => {
  const start = performance.now();
  return (async (): Promise<number | undefined> => {
    while (performance.now() - start < timeoutMs) {
      if (state.output.includes(text)) return performance.now() - start;
      await sleep(2);
    }
    return undefined;
  })();
};

// --- Part A: node-pty -> tmux data plane ---------------------------------------------------------

const session = "corvi-BASE";
tmux(["new-session", "-d", "-s", session, "-c", tmp]);

const child: IPty = pty.spawn("tmux", ["-S", tmuxSocket, "new-session", "-A", "-s", session, "-c", tmp], {
  name: "xterm-256color",
  cols: 120,
  rows: 30,
  cwd: tmp,
  env: { ...process.env, TERM: "xterm-256color", TMUX_TMPDIR: tmp },
});
const state = { output: "" };
child.onData((data) => {
  state.output += data;
});
await sleep(800); // the shell's first prompt

const rounds: number[] = [];
for (let i = 0; i < 30; i++) {
  const marker = `RTT_${i}_END`;
  state.output = "";
  const start = performance.now();
  child.write(`echo RTT_$(( ${i} + 0 ))_END\n`);
  const elapsed = await waitFor(state, marker, 5000);
  if (elapsed === undefined) throw new Error(`round ${i}: marker ${marker} did not arrive`);
  rounds.push(performance.now() - start);
}

// Output flood: 8 MB of 'x' through the pty, measured end to end.
state.output = "";
const floodBytes = 8_000_000;
const floodStart = performance.now();
child.write(`head -c ${floodBytes} /dev/zero | tr '\\0' x; echo FLOOD_$(( 0 + 1 ))_DONE\n`);
while (!state.output.includes("FLOOD_1_DONE") && performance.now() - floodStart < 60_000) await sleep(5);
const floodMs = performance.now() - floodStart;
const floodOk = state.output.includes("FLOOD_1_DONE");
child.kill();

const partA = {
  method: "node-pty -> tmux attach -t corvi-BASE (the product's pty command), private tmux socket",
  inputRoundTripMs: {
    samples: rounds.length,
    min: Number(Math.min(...rounds).toFixed(2)),
    median: Number(median(rounds).toFixed(2)),
    max: Number(Math.max(...rounds).toFixed(2)),
  },
  outputFlood: {
    bytes: floodBytes,
    ms: Number(floodMs.toFixed(1)),
    mbPerSecond: Number((floodBytes / 1_000_000 / (floodMs / 1000)).toFixed(1)),
    completed: floodOk,
  },
};
tmux(["kill-server"]);

// --- Part B: the real server, one terminal, RSS --------------------------------------------------

const require = createRequire(import.meta.url);
const wsDir = join(repoRoot, "apps", "server", "node_modules", "ws");

const readRssKb = (pid: number): number => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Number(match[1]) : NaN;
  } catch {
    return NaN;
  }
};

const waitForUrl = (proc: ChildProcess): Promise<string> =>
  new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`server did not come up:\n${seen}`)), 60_000);
    proc.stdout?.on("data", (data: Buffer) => {
      seen += data.toString("utf8");
      const found = /corvi on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(seen);
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1].replace(/\/$/, ""));
      }
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`server exited before it was up:\n${seen}`));
    });
  });

const partB = { note: "skipped" } as Record<string, unknown>;
let server: ChildProcess | undefined;
try {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CORVI_ROOT: join(tmp, "changes"),
    CORVI_ARCHIVE_ROOT: join(tmp, "changes-archive"),
    CORVI_CONFIG: join(tmp, "config.json"),
    CORVI_CACHE: join(tmp, "cache.json"),
    XDG_STATE_HOME: join(tmp, "state"),
    CORVI_PORT: "0",
    CORVI_TMUX_SOCKET: tmuxSocket,
    TMUX_TMPDIR: tmp,
    NODE_ENV: "production",
  };
  delete env.TMUX;

  server = spawn("node", ["apps/server/src/server.ts"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const url = await waitForUrl(server);
  const idleRss = readRssKb(server.pid!);

  const { execSync } = await import("node:child_process");
  const repo = join(tmp, "repo");
  execSync(`git init -q -b main ${JSON.stringify(repo)}`);
  const created = await fetch(`${url}/api/changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "BASE-1",
      checkouts: [{ path: repo, location: "original", branch: { kind: "current" } }],
    }),
  });
  if (!created.ok) throw new Error(`create change failed: ${created.status} ${await created.text()}`);

  const WebSocket = require(wsDir) as new (url: string) => {
    on: (event: string, listener: (data: Buffer | string, isBinary: boolean) => void) => void;
    send: (data: Buffer | string) => void;
    close: () => void;
  };
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(url).port}/api/changes/BASE-1/terminal/socket?cols=120&rows=30`);
  let output = "";
  socket.on("message", (data) => {
    output += (typeof data === "string" ? data : data.toString("utf8"));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket did not open")), 20_000);
    socket.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(1500); // the pty starts tmux and the shell prompts
  const terminalRss = readRssKb(server.pid!);

  const wsRounds: number[] = [];
  for (let i = 0; i < 20; i++) {
    const marker = `WRT_${i}_END`;
    socket.send(Buffer.from(`echo WRT_$(( ${i} + 0 ))_END\n`, "utf8"));
    const start = performance.now();
    for (;;) {
      if (output.includes(marker)) break;
      if (performance.now() - start > 5000) throw new Error(`ws round ${i} did not arrive`);
      await sleep(2);
    }
    wsRounds.push(performance.now() - start);
  }
  socket.close();

  partB.note = "real server on Node, one terminal over the page's WebSocket endpoint";
  partB.serverIdleRssMb = Number((idleRss / 1024).toFixed(1));
  partB.serverOneTerminalRssMb = Number((terminalRss / 1024).toFixed(1));
  partB.wsRoundTripMs = {
    samples: wsRounds.length,
    min: Number(Math.min(...wsRounds).toFixed(2)),
    median: Number(median(wsRounds).toFixed(2)),
    max: Number(Math.max(...wsRounds).toFixed(2)),
  };
} catch (e) {
  partB.error = e instanceof Error ? e.message : String(e);
} finally {
  server?.kill("SIGTERM");
  await sleep(500);
  if (server?.pid) {
    try {
      process.kill(server.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  tmux(["kill-server"]);
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({ partA, partB }, null, 2));
