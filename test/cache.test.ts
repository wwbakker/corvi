import { test, expect, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Deferred, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  clearCache,
  createCache,
  defaultCache,
  invalidate,
  swr,
  type CacheStore,
} from "../apps/server/src/capabilities/cache.ts";
import { resetRuntime, setRuntime } from "../apps/server/src/capabilities/runtime.ts";
import type { ChangeWireDto } from "@corvi/contracts/api";
import { forgetPrs } from "@corvi/github/client";
import { Cache } from "../apps/server/src/integrations/api/capabilities.ts";
import { capabilitiesLayer } from "../apps/server/src/integrations/services.ts";
import { workspaceById } from "../apps/server/src/workspace/server/index.ts";
import { checkoutsOf, runEffect, runEffectWith, runEffectWithTestClock, runSh, runSwr, TestError  } from "./helpers.ts";

const file = join(tmpdir(), "corvi-cache-test.json");
process.env.CORVI_CACHE = file;

beforeEach(() => clearCache());
afterAll(() => rm(file, { force: true }));

/** Lets a test decide when the work finishes, which is the only way to see "stale served while
 * the refresh runs" rather than guessing at timings. */
function gate<T>(value: T): { promise: Promise<T>; release: (v?: T) => void; } {
  let release: (v: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release: (v: T = value) => release(v) };
}

/** Work that says when it has started, and then waits for the gate. Awaiting `started` is what
 * makes "the refresh got to run" a fact rather than a scheduling guess, which `yield* Effect.yieldNow`
 * followed by a call count would be under load. */
function staged<T, E>(started: Deferred.Deferred<void>, finish: Effect.Effect<T, E>): Effect.Effect<T, E> {
  return Effect.andThen(Deferred.succeed(started, undefined), finish);
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
      expect(defaultCache.ageOf("k")).toBeLessThan(1000);
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
      yield* Effect.yieldNow;
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

test("an invalidate during a refresh leaves the newer answer, not the one it replaced", async () => {
  const slow = gate("old answer");

  await runEffectWithTestClock(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      yield* swr("k", 1000, Effect.succeed("first"));
      // Past the ttl: the old answer is served now, and the refresh runs behind it.
      yield* TestClock.adjust(1001);
      expect(yield* swr("k", 1000, staged(started, Effect.promise(() => slow.promise)))).toBe(
        "first",
      );
      yield* Deferred.await(started);

      // An action makes the key wrong while that refresh is still blocked, and the read that
      // follows it produces a newer answer — the one every later read must see.
      invalidate("k");
      expect(yield* swr("k", 120_000, Effect.succeed("newer"))).toBe("newer");
      const newerAge = defaultCache.ageOf("k")!;

      // The old refresh lands a minute of test time later, long after it stopped being the
      // entry's own.
      yield* TestClock.adjust(60_000);
      slow.release("old answer");
      yield* TestClock.adjust(0);

      // It writes nothing back: the newer answer stays, and is not restamped with the moment the
      // stale refresh happened to finish either.
      expect(yield* swr("k", 120_000, Effect.succeed("never asked"))).toBe("newer");
      // The helper seeds the TestClock at `Date.now()`, so an entry left alone can only get older;
      // a restamp a minute of test time later would make it look younger than it was.
      expect(defaultCache.ageOf("k")!).toBeGreaterThanOrEqual(newerAge);
    }),
  );
});

test("a refresh that fails after an invalidate leaves the newer answer alone too", async () => {
  const slow = gate("unused");

  await runEffectWithTestClock(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      // A typed failure, not a defect thrown inside the promise: this is the failure branch the
      // refresh has to keep honest.
      const failing: Effect.Effect<string, TestError> = staged(
        started,
        Effect.andThen(
          Effect.promise(() => slow.promise),
          Effect.fail(new TestError({ message: "gh: not logged in" })),
        ),
      );

      yield* swr("k", 1000, Effect.succeed("first"));
      yield* TestClock.adjust(1001);
      expect(yield* swr("k", 1000, failing)).toBe("first");
      yield* Deferred.await(started);

      invalidate("k");
      expect(yield* swr("k", 120_000, Effect.succeed("newer"))).toBe("newer");

      // "Keep the last good value" is about the entry the refresh started against: this one no
      // longer exists, so there is nothing here to put back.
      slow.release("unused");
      yield* TestClock.adjust(0);
      expect(yield* swr("k", 120_000, Effect.succeed("never asked"))).toBe("newer");
    }),
  );
});

test("an invalidate with no read behind it drops the in-flight outcome", async () => {
  const slow = gate("superseded");
  let calls = 0;

  await runEffectWithTestClock(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      // Counted when the work starts, not when it finishes: the question is how many runs this
      // key paid for.
      const work = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          calls++;
          return yield* staged(started, Effect.promise(() => slow.promise));
        });

      yield* swr("k", 1000, Effect.succeed("first"));
      yield* TestClock.adjust(1001);
      expect(yield* swr("k", 1000, work())).toBe("first");
      yield* Deferred.await(started);
      expect(calls).toBe(1);

      // Nothing takes the key while that refresh is in flight, so when it lands there is nowhere
      // for its superseded outcome to go.
      invalidate("k");
      slow.release("superseded");
      yield* TestClock.adjust(0);

      // The next reader pays for a run of its own rather than being handed the dropped answer.
      expect(yield* swr("k", 120_000, Effect.sync(() => `answer ${++calls}`))).toBe("answer 2");
      expect(calls).toBe(2);
    }),
  );
});

test("an old refresh landing during a newer in-flight read does not drop that read's placeholder", async () => {
  const oldGate = gate("old answer");
  const newGate = gate("newer answer");
  let oldCalls = 0;
  let newCalls = 0;
  let thirdCalls = 0;

  await runEffectWithTestClock(
    Effect.gen(function* () {
      const oldStarted = yield* Deferred.make<void>();
      const newStarted = yield* Deferred.make<void>();

      const oldWork = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          oldCalls++;
          return yield* staged(oldStarted, Effect.promise(() => oldGate.promise));
        });
      const newerWork = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          newCalls++;
          return yield* staged(newStarted, Effect.promise(() => newGate.promise));
        });
      const thirdWork = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          thirdCalls++;
          return yield* Effect.promise(() => newGate.promise);
        });

      // A stale read forks an old refresh, and the gate holds it in flight.
      yield* swr("k", 1000, Effect.succeed("first"));
      yield* TestClock.adjust(1000);
      expect(yield* swr("k", 1000, oldWork())).toBe("first");
      yield* Deferred.await(oldStarted);
      expect(oldCalls).toBe(1);

      // An action invalidates while it runs, and the next read starts a refresh of its own. That
      // one is still in flight when the old refresh lands.
      invalidate("k");
      const second = yield* Effect.forkChild(swr("k", 120_000, newerWork()));
      yield* Deferred.await(newStarted);
      expect(newCalls).toBe(1);

      // The stale refresh must leave the entry alone: it holds the newer read's placeholder, and
      // the deferred everyone joining that read waits on.
      oldGate.release("old answer");
      yield* TestClock.adjust(0);

      // A third reader arrives while the newer refresh is still running: it joins that one
      // rather than starting a third run.
      const third = yield* Effect.forkChild(swr("k", 120_000, thirdWork()));
      yield* TestClock.adjust(0);
      expect(thirdCalls).toBe(0);
      expect(newCalls).toBe(1);

      newGate.release("newer answer");
      yield* TestClock.adjust(0);
      expect(yield* Fiber.join(third)).toBe("newer answer");
      expect(yield* Fiber.join(second)).toBe("newer answer");
      expect(newCalls).toBe(1);
      expect(thirdCalls).toBe(0);
    }),
  );
});

test("a failing refresh whose entry is gone deletes nothing", async () => {
  const slow = gate("unused");
  const newGate = gate("newer answer");
  let secondCalls = 0;
  let thirdCalls = 0;

  await runEffectWithTestClock(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const newStarted = yield* Deferred.make<void>();

      const failing: Effect.Effect<string, TestError> = staged(
        firstStarted,
        Effect.andThen(
          Effect.promise(() => slow.promise),
          Effect.fail(new TestError({ message: "gh: not logged in" })),
        ),
      );
      const newerWork = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          secondCalls++;
          return yield* staged(newStarted, Effect.promise(() => newGate.promise));
        });
      const thirdWork = (): Effect.Effect<string> =>
        Effect.gen(function* () {
          thirdCalls++;
          return yield* Effect.promise(() => newGate.promise);
        });

      // A cold key: this refresh started with nothing to fall back on, so its failure path is the
      // one that deletes rather than the one that restores.
      const first = yield* Effect.forkChild(Effect.exit(swr("k", 1000, failing)));
      yield* Deferred.await(firstStarted);

      // Nothing of that refresh's own is in the store any more, and the next read has put a
      // placeholder of its own there.
      invalidate("k");
      const second = yield* Effect.forkChild(swr("k", 120_000, newerWork()));
      yield* Deferred.await(newStarted);
      expect(secondCalls).toBe(1);

      // The first refresh's failure lands now. Guarded, it leaves the entry alone; unguarded it
      // deletes the newer read's placeholder, having no value of its own to put back.
      slow.release("unused");
      yield* TestClock.adjust(0);
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true);

      // A third reader arrives while the newer refresh is still running: it joins that one
      // rather than paying for a run of its own.
      const third = yield* Effect.forkChild(swr("k", 120_000, thirdWork()));
      yield* TestClock.adjust(0);
      expect(thirdCalls).toBe(0);
      expect(secondCalls).toBe(1);

      newGate.release("newer answer");
      yield* TestClock.adjust(0);
      expect(yield* Fiber.join(third)).toBe("newer answer");
      expect(yield* Fiber.join(second)).toBe("newer answer");
      expect(secondCalls).toBe(1);
      expect(thirdCalls).toBe(0);
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
  expect(defaultCache.ageOf("gh:pr:PROJ-1:/a")).toBeUndefined();
  expect(defaultCache.ageOf("gh:pr:PROJ-2:/a")).toBeDefined();
});

test("forgetPrs forgets a change's cached pull-request reads", async () => {
  const change: ChangeWireDto = {
    id: "PROJ-3",
    branch: "PROJ-3-thing",
    checkouts: checkoutsOf([]),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await runSwr("gh:pr:PROJ-3:/a", 60_000, async () => "no pull request");
  await runSwr("gh:pr:PROJ-4:/a", 60_000, async () => "other change");

  // Through the capability, as the click paths call it — the invalidation has to run, not be
  // assembled and dropped.
  await runEffect(forgetPrs(change));

  expect(defaultCache.ageOf("gh:pr:PROJ-3:/a")).toBeUndefined();
  expect(defaultCache.ageOf("gh:pr:PROJ-4:/a")).toBeDefined();
});

test("the cache survives a restart, minus what is too old to trust", async () => {
  await runEffectWithTestClock(
    Effect.gen(function* () {
      // Produce "ancient" first, then walk the clock past the restore window before "fresh" —
      // the way a machine left overnight would look.
      yield* swr("ancient", 60_000, Effect.succeed("yesterday"));
      yield* TestClock.adjust(7 * 60 * 60_000);
      yield* swr("fresh", 60_000, Effect.succeed({ runs: 2 }));
      yield* defaultCache.save();

      clearCache();
      // Only the entry inside the restore window comes back.
      expect(yield* defaultCache.load()).toBe(1);
      // Restored, so the page paints from it; stale, so the first request refreshes it anyway.
      expect(yield* swr("fresh", 60_000, Effect.succeed({ runs: 99 }))).toEqual({ runs: 2 });
      expect(defaultCache.ageOf("ancient")).toBeUndefined();
    }),
  );
});

test("no more CLIs run at once than the machine can afford", async () => {
  // Counted by the processes themselves: each writes a line, so the file says how many were
  // alive together. Thirty at once is what a dashboard of six repositories asks for.
  const marks = join(tmpdir(), `corvi-parallel-${Date.now()}`);
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
  expect(peak).toBeLessThanOrEqual(Number(process.env.CORVI_PARALLEL ?? 8));
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
  const { envOf, sh } = await import("../apps/server/src/capabilities/shell.ts");
  const workspace = {
    id: "client",
    name: "Acme",
    // How two clients stop fighting over one login: another GitHub account, another tenant.
    settings: { env: { GH_CONFIG_DIR: "~/.config/gh-client", CORVI_TEST_MARK: "client" } },
  };

  // Outside a request there is no workspace, so only the global entries — none here — apply.
  expect(envOf(undefined)).toEqual({});
  expect((await runSh(["sh", "-c", "echo ${CORVI_TEST_MARK:-none}"])).stdout).toBe("none");

  // The tag carries the workspace for the whole effect, however deep the call is.
  await runEffectWith(
    workspace,
    Effect.gen(function* () {
      // A tilde is a path in practice, and a shell would have expanded it.
      expect(envOf(workspace).GH_CONFIG_DIR?.startsWith("/")).toBe(true);
      expect((yield* sh(["sh", "-c", "echo $CORVI_TEST_MARK"])).stdout).toBe("client");
      expect((yield* sh(["sh", "-c", "echo $GH_CONFIG_DIR"])).stdout).toContain("gh-client");
    }),
  );

  // And it is gone again afterwards.
  expect((await runSh(["sh", "-c", "echo ${CORVI_TEST_MARK:-none}"])).stdout).toBe("none");
});

test("two cache instances share nothing", async () => {
  const first = createCache();
  const second = createCache();
  const value = (cache: CacheStore, answer: string): Promise<string> =>
    Effect.runPromise(cache.swr("shared-key", 60_000, Effect.succeed(answer)));

  expect(await value(first, "first's answer")).toBe("first's answer");
  // The second instance has never seen the key, so it runs its own work.
  expect(await value(second, "second's answer")).toBe("second's answer");
  // And the first still answers with what it cached.
  expect(await value(first, "unused")).toBe("first's answer");
  expect(first.ageOf("shared-key")).toBeDefined();
  first.clear();
  expect(first.ageOf("shared-key")).toBeUndefined();
  expect(second.ageOf("shared-key")).toBeDefined();
});

test("the capabilities layer reads the cache the runtime installed", async () => {
  const instance = createCache();
  setRuntime({ cache: instance });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* Cache;
        return yield* cache.swr("wired", 60_000, Effect.succeed(1));
      }).pipe(Effect.provide(capabilitiesLayer(workspaceById(undefined), "test"))),
    );
    // The request's cache was the installed instance, not the process default.
    expect(instance.ageOf("wired")).toBeDefined();
    expect(defaultCache.ageOf("wired")).toBeUndefined();
  } finally {
    instance.clear();
    resetRuntime();
  }
});
