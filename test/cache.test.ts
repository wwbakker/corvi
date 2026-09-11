import { test, expect, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, TestClock } from "effect";
import { ageOf, invalidate, clearCache, loadCache, saveCache, swr } from "../src/core/platform/capabilities/cache.ts";
import { runEffectWith, runEffectWithTestClock, runSh, runSwr, TestError } from "./helpers.ts";

const file = join(tmpdir(), "iwe-cache-test.json");
process.env.IWE_CACHE = file;

beforeEach(() => clearCache());
afterAll(() => rm(file, { force: true }));

/** Lets a test decide when the work finishes, which is the only way to see "stale served while
 * the refresh runs" rather than guessing at timings. */
function gate<T>(value: T): { promise: Promise<T>; release: (v?: T) => void; } {
  let release: (v: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release: (v: T = value) => release(v) };
}

test("the first caller waits, everyone after that is instant", async () => {
  let calls = 0;
  const work = (): Effect.Effect<string, unknown> =>
    Effect.promise(async () => `answer ${++calls}`);

  await runEffectWithTestClock(
    Effect.gen(function* () {
      expect(yield* swr("k", 1000, work())).toBe("answer 1");
      expect(yield* swr("k", 1000, work())).toBe("answer 1");
      // Almost a ttl later it is still a hit, so the work runs once.
      yield* TestClock.adjust(999);
      expect(yield* swr("k", 1000, work())).toBe("answer 1");
      expect(calls).toBe(1);
      expect(ageOf("k")).toBeLessThan(1000);
    }),
  );
});

test("callers asking at the same moment share one run", async () => {
  let calls = 0;
  const slow = gate("shared");
  const work = async (): Promise<string> => {
    calls++;
    return slow.promise;
  };

  const all = Promise.all([runSwr("k", 1000, work), runSwr("k", 1000, work), runSwr("k", 1000, work)]);
  slow.release();
  expect(await all).toEqual(["shared", "shared", "shared"]);
  // One `az` for three rows asking the same question is the whole point.
  expect(calls).toBe(1);
});

test("a stale answer is handed over at once, and replaced when the refresh lands", async () => {
  let calls = 0;
  const slow = gate("answer 2");

  await runEffectWithTestClock(
    Effect.gen(function* () {
      yield* swr("k", 1000, Effect.sync(() => `answer ${++calls}`));
      // Walk past the ttl: this returns what we had rather than waiting for what is true now.
      yield* TestClock.adjust(1000);
      const stale = yield* swr(
        "k",
        1000,
        Effect.promise(async () => {
          calls++;
          return slow.promise;
        }),
      );
      expect(stale).toBe("answer 1");
      // The refresh was forked behind us; a yield lets that daemon start, which is what bumps
      // `calls` before it blocks on the gate.
      yield* Effect.yieldNow();
      expect(calls).toBe(2);

      // The refresh runs behind on its own daemon. Its work is a real promise, so the TestClock
      // cannot schedule it; `adjust(0)` yields to the scheduler until every fiber is done or
      // suspended, which replaces the old real `Bun.sleep(10)` deterministically.
      slow.release();
      yield* TestClock.adjust(0);
      expect(yield* swr("k", 60_000, Effect.succeed("never asked"))).toBe("answer 2");
    }),
  );
});

test("a failed refresh keeps the last good answer", async () => {
  const failing = (message: string): Effect.Effect<string, TestError> =>
    Effect.fail(new TestError({ message }));

  await runEffectWithTestClock(
    Effect.gen(function* () {
      yield* swr("k", 1000, Effect.succeed("good"));

      // A CLI that fails is news about the CLI, not about the work: a Jira that is down means
      // "no news", not "no data". Past the ttl, the failure runs behind the old answer.
      yield* TestClock.adjust(1000);
      const served = yield* swr("k", 1000, failing("gh: not logged in"));
      expect(served).toBe("good");
      yield* TestClock.adjust(0);
      expect(yield* swr("k", 60_000, Effect.succeed("never asked"))).toBe("good");

      // With nothing to fall back on, the failure is the answer.
      const boom: Error = yield* Effect.flip(swr("empty", 1000, failing("boom")));
      expect(boom.message).toBe("boom");
    }),
  );
});

test("an action forgets what it just made wrong", async () => {
  await runSwr("gh:pr:PROJ-1:/a", 60_000, async () => "no pull request");
  await runSwr("gh:pr:PROJ-2:/a", 60_000, async () => "other change");

  invalidate("gh:pr:PROJ-1");
  expect(ageOf("gh:pr:PROJ-1:/a")).toBeUndefined();
  expect(ageOf("gh:pr:PROJ-2:/a")).toBeDefined();
});

test("the cache survives a restart, minus what is too old to trust", async () => {
  await runEffectWithTestClock(
    Effect.gen(function* () {
      // Produce "ancient" first, then walk the clock past the restore window before "fresh" —
      // the way a machine left overnight would look.
      yield* swr("ancient", 60_000, Effect.succeed("yesterday"));
      yield* TestClock.adjust(7 * 60 * 60_000);
      yield* swr("fresh", 60_000, Effect.succeed({ runs: 2 }));
      yield* saveCache;

      clearCache();
      // Only the entry inside the restore window comes back.
      expect(yield* loadCache).toBe(1);
      // Restored, so the page paints from it; stale, so the first request refreshes it anyway.
      expect(yield* swr("fresh", 60_000, Effect.succeed({ runs: 99 }))).toEqual({ runs: 2 });
      expect(ageOf("ancient")).toBeUndefined();
    }),
  );
});

test("no more CLIs run at once than the machine can afford", async () => {
  // Counted by the processes themselves: each writes a line, so the file says how many were
  // alive together. Thirty at once is what a dashboard of six repositories asks for.
  const marks = join(tmpdir(), `iwe-parallel-${Date.now()}`);
  await Promise.all(
    Array.from({ length: 30 }, () =>
      runSh(["sh", "-c", `echo start >> ${marks}; sleep 0.05; echo end >> ${marks}`]),
    ),
  );
  const lines = (await Bun.file(marks).text()).trim().split("\n");
  await rm(marks, { force: true });

  let alive = 0;
  let peak = 0;
  for (const line of lines) {
    alive += line === "start" ? 1 : -1;
    peak = Math.max(peak, alive);
  }
  expect(peak).toBeLessThanOrEqual(Number(process.env.IWE_PARALLEL ?? 8));
});

test("a command that cannot start is a failed command, not a crash", async () => {
  // A tool that is not installed, and a working directory that is not there any more — a
  // repository moved or deleted out from under a change. Every caller knows what to do with a
  // non-zero code; none of them expect a throw.
  expect(await runSh(["definitely-not-a-real-tool"])).toMatchObject({ code: 127, stdout: "" });
  const gone = await runSh(["git", "status"], "/nowhere/at/all");
  expect(gone.code).toBe(127);
  expect(gone.stderr).toBeTruthy();
});

test("every CLI a workspace runs gets that workspace's environment", async () => {
  const { envOf, sh } = await import("../src/core/platform/capabilities/sh.ts");
  const workspace = {
    id: "client",
    name: "Acme",
    // How two clients stop fighting over one login: another GitHub account, another tenant.
    env: { GH_CONFIG_DIR: "~/.config/gh-client", IWE_TEST_MARK: "client" },
  };

  // Outside a request there is no workspace, so nothing is added.
  expect(envOf(undefined)).toEqual({});
  expect((await runSh(["sh", "-c", "echo ${IWE_TEST_MARK:-none}"])).stdout).toBe("none");

  // The tag carries the workspace for the whole effect, however deep the call is.
  await runEffectWith(
    workspace,
    Effect.gen(function* () {
      // A tilde is a path in practice, and a shell would have expanded it.
      expect(envOf(workspace).GH_CONFIG_DIR?.startsWith("/")).toBe(true);
      expect((yield* sh(["sh", "-c", "echo $IWE_TEST_MARK"])).stdout).toBe("client");
      expect((yield* sh(["sh", "-c", "echo $GH_CONFIG_DIR"])).stdout).toContain("gh-client");
    }),
  );

  // And it is gone again afterwards.
  expect((await runSh(["sh", "-c", "echo ${IWE_TEST_MARK:-none}"])).stdout).toBe("none");
});
