/**
 * Unit tests for the OSC status parser (`osc.ts`), run with `node --test`. These pin the parser's
 * recovery behaviour: split sequences survive, and a malformed or oversized sequence resyncs and
 * does not swallow the rest of the chunk.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OSC_CARRY, OSC_INTRO, parseOsc } from "./osc.ts";

const BEL = Buffer.from([0x07]);
const b64 = (object: Record<string, unknown>): Buffer =>
  Buffer.from(Buffer.from(JSON.stringify(object), "utf8").toString("base64"), "ascii");
const empty = Buffer.alloc(0);
const valid = (status: string): Buffer =>
  Buffer.concat([OSC_INTRO, b64({ status, name: "pi" }), BEL]);

test("plain output passes through unchanged", () => {
  const result = parseOsc(Buffer.from("hello world\n"), empty);
  assert.equal(result.clean.toString("utf8"), "hello world\n");
  assert.equal(result.carry.length, 0);
  assert.equal(result.statuses.length, 0);
});

test("a split introducer is held, then completed", () => {
  const first = parseOsc(Buffer.from("\x1b]1337;cor"), empty);
  assert.equal(first.clean.length, 0);
  assert.equal(first.carry.toString("binary"), "\x1b]1337;cor");
  const rest = Buffer.concat([Buffer.from("vi="), b64({ status: "working", name: "pi" }), BEL]);
  const second = parseOsc(rest, first.carry);
  assert.equal(second.carry.length, 0);
  assert.deepEqual(
    second.statuses.map((status) => status.status),
    ["working"],
  );
});

test("a split payload is held, then completed", () => {
  const body = Buffer.from(Buffer.from(JSON.stringify({ status: "waiting", message: "choose" }), "utf8").toString("base64"), "ascii");
  const first = parseOsc(Buffer.concat([OSC_INTRO, body.subarray(0, 4)]), empty);
  assert.equal(first.statuses.length, 0);
  assert.ok(first.carry.length > 0);
  const second = parseOsc(Buffer.concat([body.subarray(4), BEL]), first.carry);
  assert.equal(second.statuses.length, 1);
  assert.equal(second.statuses[0]?.status, "waiting");
  assert.equal(second.statuses[0]?.message, "choose");
});

test("a malformed introducer does not swallow a following valid sequence", () => {
  const input = Buffer.concat([OSC_INTRO, Buffer.from("AAAA"), valid("working")]);
  const result = parseOsc(input, empty);
  assert.equal(result.clean.toString("utf8"), "AAAA");
  assert.deepEqual(
    result.statuses.map((status) => status.status),
    ["working"],
  );
});

test("a non-base64 introducer resyncs to ordinary output", () => {
  const input = Buffer.concat([OSC_INTRO, Buffer.from("#ordinary\n")]);
  const result = parseOsc(input, empty);
  assert.equal(result.clean.toString("utf8"), "#ordinary\n");
  assert.equal(result.carry.length, 0);
  assert.equal(result.statuses.length, 0);
});

test("an oversized unterminated introducer forwards the rest instead of swallowing it", () => {
  const body = Buffer.from("A".repeat(MAX_OSC_CARRY + 1));
  const result = parseOsc(Buffer.concat([OSC_INTRO, body]), empty);
  assert.equal(result.clean.length, body.length);
  assert.equal(result.carry.length, 0);
  assert.equal(result.statuses.length, 0);
});

test("an oversized unterminated introducer still lets a later valid sequence through", () => {
  const input = Buffer.concat([OSC_INTRO, Buffer.from("A".repeat(MAX_OSC_CARRY + 1)), valid("waiting")]);
  const result = parseOsc(input, empty);
  assert.ok(result.clean.toString("utf8").startsWith("A".repeat(64)));
  assert.deepEqual(
    result.statuses.map((status) => status.status),
    ["waiting"],
  );
});

test("payload validation caps strings and rejects unknown statuses", () => {
  const bad = parseOsc(Buffer.concat([OSC_INTRO, b64({ status: "exploded" }), BEL]), empty);
  assert.equal(bad.statuses.length, 0);
  const long = parseOsc(Buffer.concat([OSC_INTRO, b64({ status: "working", name: "x".repeat(999) }), BEL]), empty);
  assert.equal(long.statuses.length, 1);
  assert.equal(long.statuses[0]?.name?.length, 120);
});
