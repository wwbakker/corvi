import { test, expect, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { swr, ageOf, invalidate, clearCache, loadCache, saveCache } from "../src/cache.ts";

const file = join(tmpdir(), "iwe-cache-test.json");
process.env.IWE_CACHE = file;

beforeEach(() => clearCache());
afterAll(() => rm(file, { force: true }));

/** Lets a test decide when the work finishes, which is the only way to see "stale served while
 * the refresh runs" rather than guessing at timings. */
function gate<T>(value: T) {
  let release: (v: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release: (v: T = value) => release(v) };
}

test("the first caller waits, everyone after that is instant", async () => {
  let calls = 0;
  const work = async () => `answer ${++calls}`;

  expect(await swr("k", 1000, work)).toBe("answer 1");
  expect(await swr("k", 1000, work)).toBe("answer 1");
  expect(await swr("k", 1000, work)).toBe("answer 1");
  expect(calls).toBe(1);
  expect(ageOf("k")).toBeLessThan(1000);
});

test("callers asking at the same moment share one run", async () => {
  let calls = 0;
  const slow = gate("shared");
  const work = async () => {
    calls++;
    return slow.promise;
  };

  const all = Promise.all([swr("k", 1000, work), swr("k", 1000, work), swr("k", 1000, work)]);
  slow.release();
  expect(await all).toEqual(["shared", "shared", "shared"]);
  // One `az` for three rows asking the same question is the whole point.
  expect(calls).toBe(1);
});

test("a stale answer is handed over at once, and replaced when the refresh lands", async () => {
  let calls = 0;
  await swr("k", 0, async () => `answer ${++calls}`);

  const slow = gate("answer 2");
  // Older than its ttl: this returns what we had rather than waiting for what is true now.
  expect(
    await swr("k", 0, async () => {
      calls++;
      return slow.promise;
    }),
  ).toBe("answer 1");
  expect(calls).toBe(2);

  slow.release();
  await Bun.sleep(10);
  expect(await swr("k", 60_000, async () => "never asked")).toBe("answer 2");
});

test("a failed refresh keeps the last good answer", async () => {
  await swr("k", 0, async () => "good");

  // A CLI that fails is news about the CLI, not about the work: a Jira that is down means
  // "no news", not "no data".
  const served: string = await swr<string>("k", 0, () =>
    Promise.reject(new Error("gh: not logged in")),
  );
  expect(served).toBe("good");
  await Bun.sleep(10);
  expect(await swr("k", 60_000, async () => "never asked")).toBe("good");

  // With nothing to fall back on, the failure is the answer.
  expect(swr("empty", 0, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
});

test("an action forgets what it just made wrong", async () => {
  await swr("gh:pr:PROJ-1:/a", 60_000, async () => "no pull request");
  await swr("gh:pr:PROJ-2:/a", 60_000, async () => "other change");

  invalidate("gh:pr:PROJ-1");
  expect(ageOf("gh:pr:PROJ-1:/a")).toBeUndefined();
  expect(ageOf("gh:pr:PROJ-2:/a")).toBeDefined();
});

test("the cache survives a restart, minus what is too old to trust", async () => {
  await swr("fresh", 60_000, async () => ({ runs: 2 }));
  await swr("ancient", 60_000, async () => "yesterday");
  await saveCache();

  // Age the one entry past what is worth restoring, the way a machine left overnight would.
  const stored = (await Bun.file(file).json()) as Record<string, { at: number; value: unknown }>;
  stored.ancient!.at = Date.now() - 7 * 60 * 60_000;
  await Bun.write(file, JSON.stringify(stored));

  clearCache();
  expect(await loadCache()).toBe(1);
  // Restored, so the page paints from it; stale, so the first request refreshes it anyway.
  expect(await swr("fresh", 60_000, async () => ({ runs: 99 }))).toEqual({ runs: 2 });
  expect(ageOf("ancient")).toBeUndefined();
});

test("no more CLIs run at once than the machine can afford", async () => {
  const { sh } = await import("../src/sh.ts");

  // Counted by the processes themselves: each writes a line, so the file says how many were
  // alive together. Thirty at once is what a dashboard of six repositories asks for.
  const marks = join(tmpdir(), `iwe-parallel-${Date.now()}`);
  await Promise.all(
    Array.from({ length: 30 }, () =>
      sh(["sh", "-c", `echo start >> ${marks}; sleep 0.05; echo end >> ${marks}`]),
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
