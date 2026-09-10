import { test, expect, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { ageOf, invalidate, clearCache, loadCache, saveCache } from "../src/cache.ts";
import { runEffect, runEffectWith, runSh, runSwr } from "./helpers.ts";

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
  const work = async (): Promise<string> => `answer ${++calls}`;

  expect(await runSwr("k", 1000, work)).toBe("answer 1");
  expect(await runSwr("k", 1000, work)).toBe("answer 1");
  expect(await runSwr("k", 1000, work)).toBe("answer 1");
  expect(calls).toBe(1);
  expect(ageOf("k")).toBeLessThan(1000);
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
  await runSwr("k", 0, async () => `answer ${++calls}`);

  const slow = gate("answer 2");
  // Older than its ttl: this returns what we had rather than waiting for what is true now.
  expect(
    await runSwr("k", 0, async () => {
      calls++;
      return slow.promise;
    }),
  ).toBe("answer 1");
  expect(calls).toBe(2);

  slow.release();
  await Bun.sleep(10);
  expect(await runSwr("k", 60_000, async () => "never asked")).toBe("answer 2");
});

test("a failed refresh keeps the last good answer", async () => {
  await runSwr("k", 0, async () => "good");

  // A CLI that fails is news about the CLI, not about the work: a Jira that is down means
  // "no news", not "no data".
  const served: string = await runSwr<string>("k", 0, () =>
    Promise.reject(new Error("gh: not logged in")),
  );
  expect(served).toBe("good");
  await Bun.sleep(10);
  expect(await runSwr("k", 60_000, async () => "never asked")).toBe("good");

  // With nothing to fall back on, the failure is the answer.
  expect(runSwr("empty", 0, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
});

test("an action forgets what it just made wrong", async () => {
  await runSwr("gh:pr:PROJ-1:/a", 60_000, async () => "no pull request");
  await runSwr("gh:pr:PROJ-2:/a", 60_000, async () => "other change");

  invalidate("gh:pr:PROJ-1");
  expect(ageOf("gh:pr:PROJ-1:/a")).toBeUndefined();
  expect(ageOf("gh:pr:PROJ-2:/a")).toBeDefined();
});

test("the cache survives a restart, minus what is too old to trust", async () => {
  await runSwr("fresh", 60_000, async () => ({ runs: 2 }));
  await runSwr("ancient", 60_000, async () => "yesterday");
  await runEffect(saveCache);

  // Age the one entry past what is worth restoring, the way a machine left overnight would.
  const stored = (await Bun.file(file).json()) as Record<string, { at: number; value: unknown }>;
  stored.ancient!.at = Date.now() - 7 * 60 * 60_000;
  await Bun.write(file, JSON.stringify(stored));

  clearCache();
  expect(await runEffect(loadCache)).toBe(1);
  // Restored, so the page paints from it; stale, so the first request refreshes it anyway.
  expect(await runSwr("fresh", 60_000, async () => ({ runs: 99 }))).toEqual({ runs: 2 });
  expect(ageOf("ancient")).toBeUndefined();
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
  const { envOf, sh } = await import("../src/sh.ts");
  const workspace = {
    id: "client",
    name: "Acme",
    // How two clients stop fighting over one login: another GitHub account, another tenant.
    env: { GH_CONFIG_DIR: "~/.config/gh-client", IWE_TEST_MARK: "client" },
  };

  // Outside a request there is nothing to add, which is every call IWE made before workspaces.
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
