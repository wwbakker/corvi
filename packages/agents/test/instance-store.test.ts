import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";

import {
  appendMessage,
  createInstance,
  instanceDir,
  listInstances,
  readInstance,
  removeInstance,
  SubagentStoreError,
  writeRecord,
} from "../src/node/instance.ts";
import type { SubagentRecord } from "../src/instance.ts";

const record = (id: string): SubagentRecord => ({
  id,
  changeId: "change-1",
  profile: "builtin:reviewer",
  label: "Reviewer",
  harness: "pi",
  createdBy: "orchestrator",
  createdAt: "2026-01-01T00:00:00.000Z",
  log: [{ kind: "created", at: "2026-01-01T00:00:00.000Z" }],
});

const inTemp = async (body: (changeDir: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "agents-instance-"));
  try {
    await body(join(root, "changes", "change-1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("an instance is created, read back and listed", async () => {
  await inTemp(async (changeDir) => {
    await Effect.runPromise(createInstance(changeDir, record("s1")));
    const read = await Effect.runPromise(readInstance(changeDir, "s1"));
    expect(read?.id).toBe("s1");
    expect(read?.messages).toEqual([]);
    expect(await Effect.runPromise(readInstance(changeDir, "nope"))).toBeNull();
    expect((await Effect.runPromise(listInstances(changeDir))).map((i) => i.id)).toEqual(["s1"]);
  });
});

test("removeInstance reports a typed store error when the directory cannot be removed", async () => {
  await inTemp(async (changeDir) => {
    // A regular file where the change directory should be makes `rm` reject with ENOTDIR rather
    // than silently succeeding. It must be a typed failure, not a defect that escapes.
    await mkdir(dirname(changeDir), { recursive: true });
    await writeFile(changeDir, "not a directory");
    const result = await Effect.runPromise(Effect.result(removeInstance(changeDir, "s1")));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SubagentStoreError);
      expect(result.failure._tag).toBe("SubagentStoreError");
      expect(result.failure.operation).toBe("remove");
    }
  });
});

test("creating an instance twice is refused", async () => {
  await inTemp(async (changeDir) => {
    await Effect.runPromise(createInstance(changeDir, record("s1")));
    await expect(Effect.runPromise(createInstance(changeDir, record("s1")))).rejects.toThrow(
      /already exists/,
    );
  });
});

test("messages are numbered sequentially, and concurrent appends cannot collide", async () => {
  await inTemp(async (changeDir) => {
    await Effect.runPromise(createInstance(changeDir, record("s1")));
    // Ten appends with no ordering: the per-subagent lock is what makes the numbers 1..10.
    const appended = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 10 }, (_, index) =>
          appendMessage(changeDir, "s1", {
            role: index % 2 === 0 ? "orchestrator" : "user",
            body: `m${index}`,
            at: "2026-01-01T00:00:00.000Z",
          }),
        ),
        { concurrency: "unbounded" },
      ),
    );
    const numbers = appended.map((message) => message.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const read = await Effect.runPromise(readInstance(changeDir, "s1"));
    expect(read?.messages.map((message) => message.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

test("a record patch is written atomically and read back", async () => {
  await inTemp(async (changeDir) => {
    await Effect.runPromise(createInstance(changeDir, record("s1")));
    const before = (await Effect.runPromise(readInstance(changeDir, "s1")))!;
    await Effect.runPromise(
      writeRecord(changeDir, {
        ...before,
        deliveredThrough: 3,
        inFlight: 3,
        log: [...before.log, { kind: "turn_started", at: "2026-01-01T00:00:01.000Z" }],
      }),
    );
    const after = (await Effect.runPromise(readInstance(changeDir, "s1")))!;
    expect(after.deliveredThrough).toBe(3);
    expect(after.inFlight).toBe(3);
    expect(after.log.at(-1)?.kind).toBe("turn_started");
    // The messages directory exists beside the record.
    expect(instanceDir(changeDir, "s1").endsWith("/subagents/s1")).toBe(true);
  });
});
