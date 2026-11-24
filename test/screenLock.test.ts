import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeLockHolder,
  lockContents,
  lockStateOf,
  readLock,
  releaseLock,
  takeLock,
} from "../scripts/screen-lock.ts";

/**
 * The lock's pure half: what a file's contents mean, and whether the run it names is in the way.
 *
 * `scripts/screens.ts` owns the file — reading, writing with `wx`, removing it — and the decide
 * step is here, so a take-over rule that stops a second run cannot rot untested. `isLive` stands
 * in for the process probe, which is the only part that needs the system.
 */

/** A probe that says only these pids exist. */
const alive = (...pids: readonly number[]): ((pid: number) => boolean) => {
  const live = new Set(pids);
  return (pid) => live.has(pid);
};

const holder = (token: string, pid: number): string => lockContents({ token, pid });

test("no file at all is a free lock", () => {
  expect(lockStateOf(undefined, alive())).toEqual({ kind: "free" });
});

test("a lock naming a live pid is held, with its holder", () => {
  expect(lockStateOf(holder("abc.123", 42), alive(42))).toEqual({
    kind: "held",
    holder: { token: "abc.123", pid: 42 },
  });
});

test("a lock naming a pid that is gone is stale, so a crashed run cannot block the tool", () => {
  expect(lockStateOf(holder("abc.123", 42), alive())).toEqual({
    kind: "stale",
    holder: { token: "abc.123", pid: 42 },
  });
});

test("a file that is not a lock is unreadable, never free", () => {
  // A lock that cannot be read is not a lock that may be overwritten: what it guards is unknown,
  // and the fix is for a person to look.
  expect(lockStateOf("", alive())).toEqual({ kind: "unreadable", contents: "" });
  expect(lockStateOf("   \n", alive())).toEqual({ kind: "unreadable", contents: "" });
  expect(lockStateOf("not json", alive())).toEqual({ kind: "unreadable", contents: "not json" });
  expect(lockStateOf("null", alive())).toEqual({ kind: "unreadable", contents: "null" });
  expect(lockStateOf("[]", alive())).toEqual({ kind: "unreadable", contents: "[]" });
  // The old format kept the token and pid at the top level; a holder missing either is not one.
  expect(lockStateOf('{"pid":42}', alive(42)).kind).toBe("unreadable");
  expect(lockStateOf('{"token":"abc.123"}', alive(42)).kind).toBe("unreadable");
  expect(lockStateOf('{"token":"","pid":42}', alive(42)).kind).toBe("unreadable");
  expect(lockStateOf('{"token":"abc.123","pid":"42"}', alive(42)).kind).toBe("unreadable");
  expect(lockStateOf('{"token":"abc.123","pid":0}', alive(42)).kind).toBe("unreadable");
  expect(lockStateOf('{"token":"abc.123","pid":1.5}', alive(42)).kind).toBe("unreadable");
});

test("the contents a run writes are what parsing reads back", () => {
  const contents = lockContents({ token: "abc.123", pid: 7 });
  expect(contents.endsWith("\n")).toBe(true);
  expect(lockStateOf(contents, alive(7))).toEqual({ kind: "held", holder: { token: "abc.123", pid: 7 } });
});

test("a holder is named for the refusal, and an unreadable file by its contents", () => {
  expect(describeLockHolder(lockStateOf(holder("abc.123", 42), alive(42)))).toBe("run token abc.123, pid 42");
  expect(describeLockHolder(lockStateOf(holder("abc.123", 42), alive()))).toBe("run token abc.123, pid 42");
  expect(describeLockHolder({ kind: "unreadable", contents: "not json" })).toBe(
    "unreadable contents: not json",
  );
  expect(describeLockHolder({ kind: "free" })).toBe("nobody");
});

test("a run takes the lock with wx, and releases only its own", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screen-lock-test-"));
  const path = join(dir, "run.lock");
  try {
    expect(await takeLock(path, "test", "own.1")).toBeUndefined();
    expect(await readLock(path)).toEqual({ kind: "held", holder: { token: "own.1", pid: process.pid } });
    // Another run's release is not this file's to remove.
    await releaseLock(path, "other.2");
    expect((await readLock(path)).kind).toBe("held");
    await releaseLock(path, "own.1");
    expect(await readLock(path)).toEqual({ kind: "free" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale lock with no live resources is taken over by the next run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screen-lock-test-"));
  const path = join(dir, "run.lock");
  try {
    await writeFile(path, lockContents({ token: "stale.3", pid: 999_999 }));
    expect(await takeLock(path, "test", "next.4")).toBeUndefined();
    expect(await readLock(path)).toEqual({ kind: "held", holder: { token: "next.4", pid: process.pid } });
    expect(await readFile(path, "utf8")).toBe(lockContents({ token: "next.4", pid: process.pid }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
