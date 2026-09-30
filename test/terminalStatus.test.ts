import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureHost, type HostClient } from "../apps/server/src/terminals/host/client.ts";
import { checkoutsOf, runSh, serverEnv, testRun, testTempDir, tmuxTempDir, waitFor, waitForUrl } from "./helpers.ts";

/**
 * The agent-status channel end to end: the endpoint, its validation, the presenter that reads the
 * store, and the `corvi status` CLI. The server runs on Node (the host does too); the tmux socket
 * is the run's own so the server's tmux reads never touch the user's server.
 */
// The tmux env this file sets, saved so a co-located test file does not inherit it.
const savedTmuxEnv = {
  TMUX: process.env.TMUX,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  CORVI_TMUX_SOCKET: process.env.CORVI_TMUX_SOCKET,
};
const restoreTmuxEnv = (): void => {
  for (const [key, value] of Object.entries(savedTmuxEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

let tmp: string;
let tmuxTmp: string;
let testSocket: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
const id = "PROJ-STATUS";

const startServer = async (): Promise<void> => {
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: { ...serverEnv(tmp, { TMUX_TMPDIR: tmuxTmp }), CORVI_TMUX_SOCKET: testSocket },
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
};

const hostSocket = (): string => join(tmp, "state", "corvi", "host.sock");

const hostClient = async (): Promise<HostClient> =>
  (await ensureHost({ socket: hostSocket(), checkout: process.cwd(), buildId: "dev", runtime: "node" })).client;

/** Open a host window through the window route and return its session id and incarnation. */
const openWindow = async (): Promise<{ sessionId: string; incarnation: number }> => {
  const windows = (await fetch(`${url}/api/changes/${id}/terminal/windows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "new" }),
  }).then((response) => response.json())) as { id: string; active: boolean }[];
  const sessionId = (windows.find((window) => window.active) ?? windows[windows.length - 1])?.id;
  if (sessionId === undefined) throw new Error("the new window did not appear");
  const session = (await (await hostClient()).list()).find((entry) => entry.id === sessionId);
  if (session === undefined) throw new Error("the new window has no host session");
  return { sessionId, incarnation: session.incarnation };
};

const postStatus = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${url}/api/terminals/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const windowsOf = async (): Promise<Record<string, { id: string; icon?: string; label: string; busy: boolean; attention: boolean; state?: string }[]>> =>
  (await fetch(`${url}/api/terminals`).then((response) => response.json())) as never;

beforeAll(async () => {
  tmp = await testTempDir("status");
  tmuxTmp = await tmuxTempDir();
  delete process.env.TMUX;
  process.env.TMUX_TMPDIR = tmuxTmp;
  testSocket = join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`, "corvi");
  await mkdir(join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
  await startServer();
  const repo = join(tmp, "repo");
  await runSh(["git", "init", "-b", "main", repo]);
  await fetch(`${url}/api/changes`, { method: "POST", body: JSON.stringify({ id, checkouts: checkoutsOf([repo]) }) });
}, 60_000);

afterAll(async () => {
  restoreTmuxEnv();
  server?.kill();
  await server?.exited;
  await ensureHost({ socket: hostSocket(), checkout: process.cwd(), buildId: "dev", runtime: "node" })
    .then((result) => result.client.shutdown())
    .catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
}, 60_000);

test("an endpoint report presents the host window as an agent, and clear returns it to a shell", async () => {
  const { sessionId, incarnation } = await openWindow();
  expect(
    (await postStatus({ sessionId, incarnation, status: "working", name: "pi", sessionName: "Fix login", message: "on it" })).ok,
  ).toBe(true);
  let window = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(window?.icon).toBe("agent");
  expect(window?.label).toBe("Fix login");
  expect(window?.busy).toBe(true);
  expect(window?.attention).toBe(false);
  expect(window?.state).toBe("ok");

  // A stale incarnation is refused, and never overwrites the live one.
  expect((await postStatus({ sessionId, incarnation: incarnation + 1, status: "waiting" })).ok).toBe(false);
  window = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(window?.state).toBe("ok");

  expect((await postStatus({ sessionId, incarnation, status: "waiting", name: "pi" })).ok).toBe(true);
  window = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(window?.attention).toBe(true);
  expect(window?.state).toBe("idle");

  expect((await postStatus({ sessionId, incarnation, status: "clear" })).ok).toBe(true);
  window = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(window?.icon).toBe("terminal");
  expect(window?.attention).toBe(false);
}, 40_000);

test("a dead session's status is not presented, and a reused id starts clean", async () => {
  const { sessionId, incarnation } = await openWindow();
  expect((await postStatus({ sessionId, incarnation, status: "waiting", name: "pi" })).ok).toBe(true);
  const client = await hostClient();
  await client.kill(sessionId);
  // `kill` only signals the pty; the session is alive until the host observes the exit, so wait
  // for that before asserting the refusal (the endpoint accepts a session with a kill pending).
  await waitFor(
    "the kill to land",
    async () => (await client.list()).find((entry) => entry.id === sessionId)?.alive === false,
    15_000,
  );
  // A status for the dead incarnation is refused.
  expect((await postStatus({ sessionId, incarnation, status: "working" })).ok).toBe(false);
  // The window is gone from the presentation.
  await waitFor("the dead window to disappear", async () => !(await windowsOf())[id]?.some((entry) => entry.id === sessionId), 20_000);
}, 40_000);

test("the corvi status CLI reports from the pty environment and fails without it", async () => {
  const { sessionId, incarnation } = await openWindow();
  const cli = Bun.spawn(["bun", "apps/cli/src/main.ts", "--json", "status", "working", "--name", "pi", "--server", url], {
    env: { ...process.env, CORVI_SESSION_ID: sessionId, CORVI_SESSION_INCARNATION: String(incarnation) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out.trim())).toMatchObject({ ok: true, status: "working" });
  const window = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(window?.icon).toBe("agent");
  expect(window?.busy).toBe(true);

  // No session id: a clear failure, not a silent no-op.
  const bare = Bun.spawn(["bun", "apps/cli/src/main.ts", "status", "working", "--server", url], {
    env: { ...process.env, CORVI_SESSION_ID: "", CORVI_SESSION_INCARNATION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, bareCode] = await Promise.all([new Response(bare.stderr).text(), bare.exited]);
  expect(bareCode).not.toBe(0);
  expect(err).toContain("no Corvi session");
}, 40_000);

test("a plain shell is a terminal, not an agent", async () => {
  const { sessionId } = await openWindow();
  const window = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(window?.icon).toBe("terminal");
  expect(window?.attention).toBe(false);
}, 40_000);

test("a reporter inside the pty updates the window and fires the notify edge once", async () => {
  const controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  const stream = fetch(`${url}/api/events`, { signal: controller.signal })
    .then(async (response) => {
      const reader = response.body?.getReader();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const line = block.split("\n").find((entry) => entry.startsWith("data: "));
          if (line !== undefined) {
            try {
              events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
            } catch {
              // a frame this test does not read
            }
          }
          at = buffer.indexOf("\n\n");
        }
      }
    })
    .catch(() => undefined);
  try {
    await waitFor(
      "the server to watch for pages",
      async () => ((await fetch(`${url}/api/events/listeners`).then((response) => response.json())) as { watching: boolean }).watching === true,
      15_000,
    );
    const { sessionId } = await openWindow();
    const client = await hostClient();
    // The reporter, run inside the pty: a bare `corvi` resolves through the PATH the host seeded,
    // reads the session id and incarnation from the environment, and reaches this server. Exactly
    // as pi's extension invokes it.
    client.write(sessionId, "corvi status working --name pi --session-name 'Fix login'\n");
    await waitFor(
      "the working agent window",
      async () => (await windowsOf())[id]?.find((entry) => entry.id === sessionId)?.label === "Fix login",
      20_000,
    );
    // Let the watcher observe the working state (attention false) before the edge to waiting.
    await Bun.sleep(2500);
    client.write(sessionId, "corvi status waiting --name pi --session-name 'Fix login'\n");
    await waitFor(
      "the waiting window",
      async () => (await windowsOf())[id]?.find((entry) => entry.id === sessionId)?.attention === true,
      20_000,
    );
    await Bun.sleep(2500);
    const notifies = events.filter((event) => event["label"] === "Fix login");
    expect(notifies).toHaveLength(1);
    // A repeated waiting is not a new edge: still exactly one notification.
    client.write(sessionId, "corvi status waiting --name pi --session-name 'Fix login'\n");
    await Bun.sleep(3000);
    expect(events.filter((event) => event["label"] === "Fix login")).toHaveLength(1);
  } finally {
    controller.abort();
    await stream;
  }
}, 60_000);

test("a status emitted as OSC presents through the presenter, and clear suppresses it", async () => {
  const { sessionId, incarnation } = await openWindow();
  const client = await hostClient();
  const payload = Buffer.from(JSON.stringify({ status: "working", name: "pi", sessionName: "Osc session" }), "utf8").toString("base64");
  client.write(sessionId, `printf '\\033]1337;corvi=${payload}\\007'; sleep 30\n`);
  await waitFor(
    "the OSC status to present",
    async () => (await windowsOf())[id]?.find((entry) => entry.id === sessionId)?.label === "Osc session",
    20_000,
  );
  const shown = (await windowsOf())[id]?.find((entry) => entry.id === sessionId);
  expect(shown?.icon).toBe("agent");
  // An explicit clear is a tombstone: it suppresses the host's OSC status too.
  expect((await postStatus({ sessionId, incarnation, status: "clear" })).ok).toBe(true);
  await waitFor(
    "the clear to suppress the OSC status",
    async () => (await windowsOf())[id]?.find((entry) => entry.id === sessionId)?.icon === "terminal",
    20_000,
  );
}, 40_000);
