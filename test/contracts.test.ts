import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";

import { SubagentMessageSchema, SubagentTurnRequestSchema } from "@corvi/contracts/subagents";

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
