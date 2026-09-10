import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSh } from "./helpers.ts";

/**
 * The push side of the pages: one connection that says when something changed, instead of every
 * open page asking every second and a half.
 *
 * Driven through a real server over a real stream, because everything that can go wrong here is
 * about the connection — a stream that says nothing, a stream that says everything twice, a
 * watcher that keeps running after the last page has gone.
 */
let tmp: string;
let port: number;
let server: ReturnType<typeof Bun.spawn>;
let url: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iwe-events-"));
  port = 4700 + Math.floor(Math.random() * 200);
  url = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "src/server.ts", "--iwe-test-run"], {
    env: {
      ...process.env,
      IWE_ROOT: join(tmp, "changes"),
      IWE_PORT: String(port),
      IWE_CONFIG: join(tmp, "config.json"),
    },
    stdout: "ignore",
    stderr: process.env.IWE_TEST_LOUD ? "inherit" : "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${url}/api/changes`).catch(() => null))?.ok) break;
    await Bun.sleep(100);
  }
});

afterAll(async () => {
  server?.kill();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Listen, and hand back the events as they arrive.
 *
 * Stopping aborts the request rather than cancelling the reader: a cancelled reader leaves the
 * connection in the pool, so the server hears nothing and keeps the listener — which is a fair
 * imitation of a browser that has crashed, but not of one that closed the tab.
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

  // The stream says "open" as soon as it is: an EventSource that has had nothing at all is
  // indistinguishable from one that never connected.
  for (let i = 0; i < 30 && seen.length === 0; i++) await Bun.sleep(50);
  return {
    seen,
    stop: async () => {
      aborter.abort();
      await Bun.sleep(50); // the server is told by the connection closing, not by us
    },
  };
}

const until = async (has: () => boolean | Promise<boolean>, tries = 60): Promise<boolean> => {
  for (let i = 0; i < tries && !(await has()); i++) await Bun.sleep(100);
  return await has();
};

test("a page hears about a change it did not make", async () => {
  const { seen, stop } = await listen();
  expect(seen[0]).toBe("open");

  const repo = join(tmp, "example-api");
  await runSh(["git", "init", "-b", "main", repo]);
  // Made through the API, as another window would: the route says so at once, and the watcher
  // would have found it within a tick anyway. Settling first, so anything the watcher's own
  // first look announces is not mistaken for the change this test makes.
  await Bun.sleep(2000);
  const before = seen.length;
  await fetch(`${url}/api/changes`, {
    method: "POST",
    body: JSON.stringify({ id: "PROJ-EVENT", branch: "PROJ-EVENT-x", repos: [repo] }),
  });

  expect(await until(() => seen.length > before)).toBe(true);
  expect(seen.slice(before)).toContain("changes");
  await stop();
}, 20_000);

test("nothing is said when nothing happened", async () => {
  const { seen, stop } = await listen();
  // Two ticks of the watcher, with the state on disk left alone: whatever the first look
  // announced — a fresh watcher announces what it finds, an old one has nothing new — nothing
  // repeats and nothing foreign arrives.
  await Bun.sleep(3500);
  expect(seen[0]).toBe("open");
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.every((e) => ["open", "changes", "windows", "notify"].includes(e))).toBe(true);
  await stop();
}, 20_000);

test("a change written by anything at all is noticed", async () => {
  const { seen, stop } = await listen();

  // Not through the API: a `git` command in a terminal, another window, a hand-edited file. The
  // watcher is what makes those arrive, and why announcing from a route is an optimisation
  // rather than the mechanism. The greeting has settled by now (the watcher's first look fired
  // within a tick of connect), so anything new down the wire is the edit, not the hello.
  await Bun.sleep(2000);
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
  const state = async (): Promise<{ listeners: number; watching: boolean }> =>
    (await fetch(`${url}/api/events/listeners`).then((r) => r.json())) as {
      listeners: number;
      watching: boolean;
    };

  const { stop } = await listen();
  expect(await state()).toEqual({ listeners: 1, watching: true });

  await stop();
  // Asked of the server, because the point is that the process is not looking at the disk and at
  // tmux twice a second for a browser that has been closed since this morning.
  expect(await until(async () => (await state()).listeners === 0)).toBe(true);
  expect(await state()).toEqual({ listeners: 0, watching: false });
}, 20_000);
