import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";

import { serverEnv, testRun, testTempDir, waitForUrl } from "./helpers.ts";

/**
 * The power API over a real server: the local machine arms, counts down, disarms, and says so on
 * the event stream.
 *
 * The countdown is set to an hour so nothing can reach the deadline during the run — the real
 * `systemctl`/`osascript` must never be reached from a test.
 */
let tmp: string;
let server: ReturnType<typeof Bun.spawn>;
let url: string;

beforeAll(async () => {
  tmp = await testTempDir("power");
  server = Bun.spawn(["node", "apps/server/src/server.ts", `--corvi-test-run=${testRun()}`], {
    env: serverEnv(tmp, { CORVI_POWER_COUNTDOWN_MS: "3600000" }),
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

type State = { phase: string; deadline?: string; error?: string; agents: unknown[] };

const state = async (): Promise<State> => (await fetch(`${url}/api/power`).then((r) => r.json())) as State;

const post = async (path: string, body?: unknown): Promise<unknown> =>
  fetch(`${url}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).then((r) => r.json());

/** The event names arriving on `/api/events` — the same stream the page listens to. */
async function listen(): Promise<{ seen: string[]; stop: () => Promise<void> }> {
  const aborter = new AbortController();
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

  // The greeting means the client is registered, so a `power` seen later is the announce rather
  // than the hello.
  expect(await until(() => seen.includes("changes") && seen.includes("windows"))).toBe(true);
  return {
    seen,
    stop: async () => {
      aborter.abort();
    },
  };
}

test("the machine starts disarmed, with the agent list the countdown would wait on", async () => {
  const before = await state();
  expect(before.phase).toBe("disarmed");
  expect(before.agents).toEqual([]);
});

test("arm reports armed, the state read sees the countdown, and disarm reports disarmed", async () => {
  const armed = await post("/api/power/arm", { targets: [""] });
  expect(armed).toEqual({ results: [{ source: "", status: "armed" }] });

  // The ticker moves armed -> counting-down within a second, so either is correct here.
  const after = await state();
  expect(["armed", "counting-down"]).toContain(after.phase);

  const disarmed = await post("/api/power/disarm", { targets: [""] });
  expect(disarmed).toEqual({ results: [{ source: "", status: "disarmed" }] });
  expect((await state()).phase).toBe("disarmed");
});

test("every target gets a result, and a remote is reported rather than dropped", async () => {
  // No workspace named `remote-client` is configured here, which is itself a fan-out answer.
  const remote = {
    source: "remote-client",
    status: "unsupported",
    detail: "no such remote workspace",
  };
  expect(await post("/api/power/arm", { targets: ["", "remote-client"] })).toEqual({
    results: [{ source: "", status: "armed" }, remote],
  });
  expect(await post("/api/power/disarm", { targets: ["", "remote-client"] })).toEqual({
    results: [{ source: "", status: "disarmed" }, remote],
  });
});

test("arming and disarming each announce a power event on the stream", async () => {
  const { seen, stop } = await listen();

  const beforeArm = seen.length;
  await post("/api/power/arm", { targets: [""] });
  expect(await until(() => seen.slice(beforeArm).includes("power"))).toBe(true);

  const beforeDisarm = seen.length;
  await post("/api/power/disarm", { targets: [""] });
  expect(await until(() => seen.slice(beforeDisarm).includes("power"))).toBe(true);

  await stop();
}, 20_000);
