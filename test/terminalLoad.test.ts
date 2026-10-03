import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ensureHost } from "../apps/server/src/terminals/host/client.ts";
import { checkoutsOf, runSh, serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";

/**
 * What a flood costs the rest of the server. A terminal screen is parsed and serialized on the
 * server; a window that never stops painting must not make the read routes — the ones the page
 * polls for its window strip and navigation — wait behind it. The screens with no page attached are
 * released after their grace, which is what keeps several agents affordable; the attended one is
 * the case here, and its flood still must not stall the API.
 *
 * The server runs in its own process, as the app's does. The host outlives the server by design;
 * the test stops it with the rest.
 */
const CHANGE = "LOAD-1";
const FLOOD = "yes FLOOD-0123456789ABCDEF | head -c 12000000";

let tmp: string;
let server: ReturnType<typeof Bun.spawn>;
let baseUrl: string;
let savedStateHome: string | undefined;

/** A socket to one pane; resolves once the server's snapshot means the screen is attached. */
const attach = (pane: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = new WebSocket(
      `ws://${url.host}/api/changes/${CHANGE}/terminal/socket?cols=80&rows=24&session=${encodeURIComponent(pane)}`,
    );
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as { type?: string };
      if (frame.type === "snapshot" || frame.type === "reset") resolve(socket);
    };
    socket.onerror = () => reject(new Error("the terminal socket failed"));
  });

/** Open a new window and return its pane session id. */
const newPane = async (): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/changes/${CHANGE}/terminal/windows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "new" }),
  });
  const windows = (await response.json()) as { activePane: string }[];
  return windows[windows.length - 1]!.activePane;
};

beforeAll(async () => {
  tmp = await testTempDir("terminal-load");
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(tmp, "state");
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    cwd: resolve("."),
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: "pipe",
  });
  baseUrl = await waitForUrl(server);
  await fetch(`${baseUrl}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: CHANGE, checkouts: checkoutsOf([repo]) }),
  });
}, 120_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  await ensureHost({
    socket: join(tmp, "state", "corvi", "host.sock"),
    checkout: process.cwd(),
    buildId: process.env.CORVI_BUILD ?? "dev",
    runtime: "node",
  })
    .then((result) => result.client.shutdown())
    .catch(() => undefined);
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  await rm(tmp, { recursive: true, force: true });
}, 60_000);

test("a flood on an attended screen leaves the read routes responsive", async () => {
  const pane = await newPane();
  const socket = await attach(pane);
  // The flood, typed as a binary frame the server treats as input.
  socket.send(Buffer.from(`${FLOOD}\n`) as unknown as ArrayBuffer);

  const latencies: number[] = [];
  const started = Date.now();
  while (Date.now() - started < 1500) {
    const at = Date.now();
    await fetch(`${baseUrl}/api/workspaces`).then((r) => r.text());
    latencies.push(Date.now() - at);
    await Bun.sleep(20);
  }
  socket.close();

  expect(latencies.length).toBeGreaterThan(5);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  expect(Math.max(...latencies)).toBeLessThan(1000);
  expect(p95).toBeLessThan(500);
}, 60_000);

test("switching between windows stays responsive while their screens paint", async () => {
  const first = await newPane();
  const second = await newPane();
  // Both screens paint continuously, so a switch has a full screen to serialize.
  const painting = await attach(first);
  painting.send(Buffer.from("while :; do printf '\\033[2J\\033[H'; yes row | head -24; sleep 0.05; done\n") as unknown as ArrayBuffer);
  const other = await attach(second);
  other.send(Buffer.from("while :; do printf '\\033[2J\\033[H'; yes row | head -24; sleep 0.05; done\n") as unknown as ArrayBuffer);
  await Bun.sleep(500);
  painting.close();
  other.close();

  const switches: number[] = [];
  for (let round = 0; round < 4; round++) {
    const at = Date.now();
    const socket = await attach(round % 2 === 0 ? first : second);
    switches.push(Date.now() - at);
    socket.close();
  }
  expect(switches).toHaveLength(4);
  expect(Math.max(...switches)).toBeLessThan(2000);
}, 60_000);
