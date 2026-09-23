import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { checkoutsOf, runSh, serverEnv, testRun, testTempDir, waitForUrl  } from "./helpers.ts";

/**
 * The push side of the pages: one connection that says when something changed, instead of every
 * open page asking every second and a half.
 *
 * Driven through a real server over a real stream, because everything that can go wrong here is
 * about the connection — a stream that says nothing, a stream that says everything twice, a
 * watcher that keeps running after the last page has gone.
 */
let tmp: string;
let server: ReturnType<typeof Bun.spawn>;
let url: string;

beforeAll(async () => {
  tmp = await testTempDir("events");
  // A tmux of its own, or none. The host's default socket carries the app's own `corvi-*`
  // sessions, and the watcher would read their windows and say `windows` in the middle of a
  // test — a terminal that is none of this test's business. Its own TMUX_TMPDIR, with the
  // inherited TMUX removed, leaves `tmux list-windows` nothing to find. The directory must
  // exist: tmux ignores a TMUX_TMPDIR it cannot enter and falls back to the default socket.
  // Both come from serverEnv, which also gives the server port 0: the OS picks a free one,
  // so parallel workers never land on the same port, and readiness is the server's own
  // `corvi on <url>` line rather than a poll.
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp),
    stdout: "pipe",
    stderr: process.env.CORVI_TEST_LOUD ? "inherit" : "ignore",
  });
  url = await waitForUrl(server);
});

afterAll(async () => {
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

const until = async (has: () => boolean | Promise<boolean>, tries = 60): Promise<boolean> => {
  for (let i = 0; i < tries && !(await has()); i++) await Bun.sleep(100);
  return await has();
};

/** What the server says about the stream: how many listeners it has, and whether the watcher is
 * running. The tests synchronise on this rather than on a guess — a listener is counted once the
 * server has it, and the watcher lives only while one is. */
const listeners = async (): Promise<{ listeners: number; watching: boolean }> =>
  (await fetch(`${url}/api/events/listeners`).then((r) => r.json())) as {
    listeners: number;
    watching: boolean;
  };

/**
 * Listen, and hand back the events as they arrive.
 *
 * Stopping aborts the request rather than cancelling the reader: a cancelled reader leaves the
 * connection in the pool, so the server hears nothing and keeps the listener — which is a fair
 * imitation of a browser that has crashed, but not of one that closed the tab.
 *
 * The stream is handed back only once the server counts it as the one listener and the watcher's
 * first look has arrived. That first look is the greeting — a watcher starts with nothing
 * remembered, so it says what it can see — and waiting for it is what keeps a test's own
 * measurement from racing it. `stop` likewise waits for the server to have forgotten the
 * listener, so the next stream starts a fresh watcher rather than joining one about to stop.
 */
async function listen(): Promise<{ seen: string[]; stop: () => Promise<void> }> {
  const aborter = new AbortController();
  // Retried once: Bun's fetch keeps connections in a pool, and the one an abort just killed is
  // handed straight back out, which arrives here as ECONNRESET. A browser has no such pool.
  const open = (): Promise<Response> => fetch(`${url}/api/events`, { signal: aborter.signal });
  const response = await open().catch(() => open());
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const seen: string[] = [];

  void (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split("\n")) {
          if (line.startsWith("event: ")) seen.push(line.slice("event: ".length));
        }
      }
    } catch {
      // The reader was cancelled: that is how this ends.
    }
  })();

  // This client, and not a second one the retry left behind.
  expect(await until(async () => (await listeners()).listeners === 1)).toBe(true);
  // The greeting: a fresh watcher says it can see changes and windows. Waiting for both keeps
  // the hello out of what a test measures, instead of sleeping for a tick and hoping.
  expect(await until(() => seen.includes("changes") && seen.includes("windows"))).toBe(true);
  return {
    seen,
    stop: async () => {
      aborter.abort();
      expect(await until(async () => (await listeners()).listeners === 0)).toBe(true);
    },
  };
}

test("a page hears about a change it did not make", async () => {
  const { seen, stop } = await listen();
  expect(seen[0]).toBe("open");

  const repo = join(tmp, "example-api");
  await runSh(["git", "init", "-b", "main", repo]);
  // Made through the API, as another window would: the route says so at once, and the watcher
  // would have found it within a tick anyway.
  const before = seen.length;
  await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: "PROJ-EVENT", branch: "PROJ-EVENT-x", checkouts: checkoutsOf([repo]) }),
  });

  expect(await until(() => seen.length > before)).toBe(true);
  expect(seen.slice(before)).toContain("changes");
  await stop();
}, 20_000);

test("a change written by anything at all is noticed", async () => {
  const { seen, stop } = await listen();

  // Not through the API: a `git` command in a terminal, another window, a hand-edited file. The
  // watcher is what makes those arrive, and why announcing from a route is an optimisation
  // rather than the mechanism. `listen` waited for the greeting, so anything new down the wire
  // is the edit, not the hello.
  const before = seen.length;
  const change = join(tmp, "changes", "PROJ-EVENT", "change.json");
  const json = JSON.parse(await Bun.file(change).text()) as { title?: string };
  await Bun.write(change, JSON.stringify({ ...json, title: "renamed on disk" }, null, 2));

  expect(await until(() => seen.length > before)).toBe(true);
  expect(seen.slice(before)).toContain("changes");
  await stop();
}, 20_000);

test("a quiet stream stays open", async () => {
  // Bun closes an idle connection after ten seconds, and an event stream is idle by definition:
  // it exists to say nothing most of the time. The browser reconnects, so the failure looks like
  // everything working — plus `request timed out` in the log six times a minute, for ever.
  const { seen, stop } = await listen();
  await Bun.sleep(13_000);
  // Still the same connection — one "open", nothing repeated, nothing foreign — and the one
  // listener is still the only one. A drop and a reconnect would have said "open" twice.
  expect(seen[0]).toBe("open");
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.every((e) => ["open", "changes", "windows", "notify"].includes(e))).toBe(true);
  expect(await (await fetch(`${url}/api/events/listeners`).then((r) => r.json())).listeners).toBe(1);
  await stop();
}, 30_000);

test("the watcher runs while a page is listening, and stops when it goes", async () => {
  const { stop } = await listen();
  expect(await listeners()).toEqual({ listeners: 1, watching: true });

  await stop();
  // Asked of the server, because the point is that the process is not looking at the disk and at
  // tmux twice a second for a browser that has been closed since this morning. `stop` waited for
  // the listener to be forgotten, and the watcher is ref-counted by that set: it stops with the
  // last client.
  expect(await listeners()).toEqual({ listeners: 0, watching: false });
}, 20_000);
