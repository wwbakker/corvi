/**
 * Probe what real agents emit when the gap reprint's exact jiggle hits their pty.
 *
 * It starts a private terminal host in a temporary state directory and opens each agent in a
 * host session whose HOME and XDG_* directories are also temporary. The session environment is an
 * allowlist (no user credentials, no provider keys); no user config or session is read or written.
 * pi is run offline; opencode runs without external plugins.
 *
 * For each state it records the host byte delta across 120x40 -> 119x40 -> 120x40 and the
 * serialized headless screen before and after. pi's history state uses a synthetic 200-message
 * session file written inside the temporary HOME.
 *
 * Run from the repository root:
 *
 *   bun scripts/probe-sigwinch.ts
 *
 * The output is one JSON object per state. A missing agent is reported as skipped.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHost, type HostClient } from "../apps/server/src/terminals/host/client.ts";
import { makeScreen, type Screen } from "../apps/server/src/terminals/server/screen.ts";

const COLS = 120;
const ROWS = 40;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ProbeState = {
  readonly name: string;
  readonly command: readonly string[];
  readonly warmupMs: number;
  readonly settleMs?: number;
};

type SessionInfo = Awaited<ReturnType<HostClient["list"]>>[number];

const sessionOf = async (client: HostClient, id: string): Promise<SessionInfo | undefined> =>
  (await client.list()).find((entry) => entry.id === id);

/** Wait until the host has emitted nothing new for `quietMs`, or the cap passes. */
const waitQuiet = async (client: HostClient, id: string, quietMs: number, maxMs: number): Promise<void> => {
  const started = Date.now();
  let seen = (await sessionOf(client, id))?.lastSeq ?? 0;
  let since = Date.now();
  for (;;) {
    await sleep(100);
    const now = (await sessionOf(client, id))?.lastSeq ?? 0;
    if (now !== seen) {
      seen = now;
      since = Date.now();
    }
    if (Date.now() - since >= quietMs || Date.now() - started >= maxMs) return;
  }
};

const probe = async (
  client: HostClient,
  home: string,
  env: Record<string, string>,
  state: ProbeState,
): Promise<Record<string, unknown> | undefined> => {
  const screen: Screen = makeScreen({ cols: COLS, rows: ROWS });
  let lastSeq = 0;
  const listener = (data: Buffer, _incarnation: number, seq: number): void => {
    lastSeq = Math.max(lastSeq, seq + data.length);
    screen.write(data, seq);
  };
  try {
    const opened = await client.open(state.name, {
      cwd: home,
      command: [...state.command],
      cols: COLS,
      rows: ROWS,
      env,
    });
    client.onData(state.name, listener);
    const attached = await client.attach(state.name, 0);
    await sleep(state.warmupMs);
    await waitQuiet(client, state.name, 700, 12_000);
    const beforeSession = await sessionOf(client, state.name);
    if (beforeSession === undefined) return { state: state.name, skipped: "the session disappeared" };
    await screen.whenApplied(beforeSession.lastSeq);
    const before = screen.serialize();
    const beforeRows = screen.bufferRows;
    const beforeScrollback = screen.scrollbackRows;

    const shrink = await client.resize(state.name, COLS - 1, ROWS);
    const grow = await client.resize(state.name, COLS, ROWS);
    await sleep(state.settleMs ?? 2500);
    await waitQuiet(client, state.name, 700, 8_000);
    const afterSession = await sessionOf(client, state.name);
    if (afterSession === undefined) return { state: state.name, skipped: "the session disappeared" };
    await screen.whenApplied(afterSession.lastSeq);
    const after = screen.serialize();

    return {
      state: state.name,
      command: state.command,
      opened,
      attached,
      alive: afterSession.alive,
      shrinkApplied: shrink,
      growApplied: grow,
      beforeSeq: beforeSession.lastSeq,
      afterSeq: afterSession.lastSeq,
      hostByteDelta: afterSession.lastSeq - beforeSession.lastSeq,
      receivedByteDelta: lastSeq - beforeSession.lastSeq,
      screenBytesBefore: Buffer.byteLength(before.data),
      screenBytesAfter: Buffer.byteLength(after.data),
      screenBytesDelta: Buffer.byteLength(after.data) - Buffer.byteLength(before.data),
      bufferRowsBefore: beforeRows,
      bufferRowsAfter: screen.bufferRows,
      bufferRowsDelta: screen.bufferRows - beforeRows,
      scrollbackBefore: beforeScrollback,
      scrollbackAfter: screen.scrollbackRows,
      scrollbackDelta: screen.scrollbackRows - beforeScrollback,
    };
  } finally {
    client.offData(state.name, listener);
    await client.kill(state.name).catch(() => undefined);
    screen.dispose();
  }
};

/** A synthetic history so pi's history/TUI state is reproducible without a user session file. */
const makePiHistory = async (home: string): Promise<string> => {
  const now = Date.now();
  const lines: Record<string, unknown>[] = [
    { type: "session", version: 3, id: randomUUID(), timestamp: new Date(now).toISOString(), cwd: home },
  ];
  let parentId: string | null = null;
  for (let index = 1; index <= 200; index++) {
    const userId = randomUUID();
    lines.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: new Date(now + index * 1000).toISOString(),
      message: { role: "user", content: `Probe message ${index}`, timestamp: now + index * 1000 },
    });
    parentId = userId;
    const assistantId = randomUUID();
    lines.push({
      type: "message",
      id: assistantId,
      parentId,
      timestamp: new Date(now + index * 2000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Probe reply ${index}: ${"detail ".repeat(20)}` }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now + index * 2000,
      },
    });
    parentId = assistantId;
  }
  const path = join(home, "history.jsonl");
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
};

const main = async (): Promise<void> => {
  const pi = Bun.which("pi");
  const opencode = Bun.which("opencode");
  if (pi === null && opencode === null) {
    console.log("no pi or opencode found on PATH; nothing to probe");
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), "corvi-sigwinch-probe-"));
  const home = join(tmp, "home");
  await mkdir(join(home, ".config"), { recursive: true });
  await mkdir(join(home, ".local", "share"), { recursive: true });
  await mkdir(join(home, ".local", "state"), { recursive: true });
  await mkdir(join(home, ".cache"), { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG ?? "C.UTF-8",
    SHELL: "/bin/sh",
    USER: "corvi-probe",
    LOGNAME: "corvi-probe",
  };
  const socket = join(tmp, "host.sock");
  const { client } = await ensureHost({
    socket,
    checkout: process.cwd(),
    buildId: "sigwinch-probe",
    runtime: "node",
  });
  try {
    if (pi !== null) {
      console.log(JSON.stringify(await probe(client, home, env, {
        name: "pi-startup",
        command: [pi, "--offline", "--no-session"],
        warmupMs: 1000,
      }), null, 2));
      const history = await makePiHistory(home);
      console.log(JSON.stringify(await probe(client, home, env, {
        name: "pi-history",
        command: [pi, "--offline", "--session", history],
        warmupMs: 1000,
      }), null, 2));
    } else {
      console.log(JSON.stringify({ state: "pi", skipped: "not found on PATH" }));
    }
    if (opencode !== null) {
      console.log(JSON.stringify(await probe(client, home, env, {
        name: "opencode-startup",
        command: [opencode, "--pure"],
        warmupMs: 6000,
      }), null, 2));
    } else {
      console.log(JSON.stringify({ state: "opencode", skipped: "not found on PATH" }));
    }
  } finally {
    await client.shutdown().catch(() => undefined);
    client.close();
    await rm(tmp, { recursive: true, force: true });
  }
};

await main();
