import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";

import { SubagentAwaitResponseSchema, SubagentMessageSchema, SubagentRecordSchema, SubagentTurnRequestSchema } from "@corvi/contracts/subagents";

import { runSh, testTempDir } from "./helpers.ts";

test("contracts bundle for the browser", async () => {
  const outdir = await testTempDir("contracts-bundle");
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../packages/contracts/src/paths.ts"),
      resolve(import.meta.dir, "../packages/contracts/src/changes.ts"),
      resolve(import.meta.dir, "../packages/contracts/src/api.ts"),
    ],
    target: "browser",
    outdir,
  });
  expect(result.success).toBe(true);
});

test("Node resolves the contracts entrypoints", async () => {
  const result = await runSh([
    "node",
    "--input-type=module",
    "-e",
    "console.log(import.meta.resolve('@corvi/contracts/changes'))",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("packages/contracts/src/changes.ts");
});

test("inReplyTo is a positive integer on the subagent boundary schemas", () => {
  const message = Schema.decodeUnknownSync(SubagentMessageSchema);
  const turn = Schema.decodeUnknownSync(SubagentTurnRequestSchema);
  const body = { number: 2, role: "subagent", at: "t", body: "b" } as const;

  expect(message({ ...body, inReplyTo: 1 })).toMatchObject({ inReplyTo: 1 });
  expect(turn({ text: "b", inReplyTo: 3 })).toEqual({ text: "b", inReplyTo: 3 });
  // Absent stays absent: a legacy reply and a turn with no attribution are both valid.
  expect(message(body).inReplyTo).toBeUndefined();
  expect(turn({ text: "b" }).inReplyTo).toBeUndefined();
  // Zero, negatives and fractions are not message numbers, so a raw boundary rejects them rather
  // than letting an unattributable turn through.
  for (const invalid of [0, -3, 1.5]) {
    expect(() => message({ ...body, inReplyTo: invalid })).toThrow();
    expect(() => turn({ text: "b", inReplyTo: invalid })).toThrow();
  }
});

test("message numbers are positive integers; the delivery cursor is non-negative", () => {
  const message = Schema.decodeUnknownSync(SubagentMessageSchema);
  const record = Schema.decodeUnknownSync(SubagentRecordSchema);
  const bare = {
    id: "s1",
    changeId: "c",
    profile: "builtin:reviewer",
    label: "Reviewer",
    harness: "pi" as const,
    createdBy: "orchestrator" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    log: [],
  };
  const valid = { ...bare, deliveredThrough: 2, inFlight: 3 };

  expect(message({ number: 1, role: "subagent", at: "t", body: "b" }).number).toBe(1);
  expect(record(valid)).toMatchObject({ deliveredThrough: 2, inFlight: 3 });
  // A record from before either cursor field existed still decodes.
  expect(record(bare)).toEqual(bare);
  // The cursor may be 0 — "nothing delivered yet" is legitimate, and a decode failure here would
  // make `readInstance` silently return null.
  expect(record({ ...valid, deliveredThrough: 0 })).toMatchObject({ deliveredThrough: 0 });
  // A message's own number and the in-flight claim are positive integers.
  for (const invalid of [0, -1, 1.5]) {
    expect(() => message({ number: invalid, role: "subagent", at: "t", body: "b" })).toThrow();
    expect(() => record({ ...valid, inFlight: invalid })).toThrow();
  }
  // The cursor is an integer or nothing — never negative, fractional or a non-number.
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    expect(() => record({ ...valid, deliveredThrough: invalid })).toThrow();
  }
});

test("the await response is per-target outcomes with no bare identity", () => {
  const decode = Schema.decodeUnknownSync(SubagentAwaitResponseSchema);
  const ready = {
    status: "ready",
    outcomes: [{ id: "s1", status: "ready", reason: "replied", turn: 1, reply: 2 }],
  } as const;
  expect(decode(ready)).toEqual(ready);
  // The horizon carries no outcome, so re-issuing re-derives settled targets from state.
  expect(decode({ status: "timeout", outcomes: [] })).toEqual({ status: "timeout", outcomes: [] });
  // The old aggregate `id`/`awaitingReply` identity is not a schema key. Effect 4 strips unknown
  // properties, so an old-shape body decodes to exactly the clean shape — and the decoded keys
  // pin that no aggregate identity can come back.
  const stripped = decode({ status: "timeout", outcomes: [], id: "s1", awaitingReply: false });
  expect(stripped).toEqual({ status: "timeout", outcomes: [] });
  expect(Object.keys(stripped)).toEqual(["status", "outcomes"]);
  // `turn` and `reply` are positive message numbers like every other turn reference.
  for (const invalid of [0, -3, 1.5]) {
    expect(() =>
      decode({ status: "ready", outcomes: [{ id: "s1", status: "ready", reason: "replied", turn: invalid }] }),
    ).toThrow();
  }
});
