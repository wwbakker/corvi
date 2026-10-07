import { expect, test } from "bun:test";
import { Result } from "effect";

import {
  answeredThrough,
  awaitDecisionOf,
  latestInboundNumber,
  latestMessage,
  messageFileOf,
  messageFileName,
  nextNumber,
  parseMessage,
  pendingInbound,
  renderMessage,
  viewOf,
  type SubagentMessage,
  type SubagentRecord,
} from "../src/instance.ts";

const message = (number: number, role: SubagentMessage["role"], body = "x"): SubagentMessage => ({
  number,
  role,
  at: "2026-01-01T00:00:00.000Z",
  body,
});

test("message files name the number and the role, and read back", () => {
  expect(messageFileName(7, "subagent")).toBe("007-subagent.md");
  expect(messageFileOf("007-subagent.md")).toEqual({ number: 7, role: "subagent" });
  expect(messageFileOf("12-orchestrator.md")).toEqual({ number: 12, role: "orchestrator" });
  expect(messageFileOf("notes.md")).toBeUndefined();
  expect(messageFileOf("007-system.md")).toBeUndefined();
  // A zero-numbered file is not a message (the store writes 1-based, zero-padded names).
  expect(messageFileOf("000-subagent.md")).toBeUndefined();
});

test("a message round-trips through its file", () => {
  const original = { ...message(1, "orchestrator", "line one\nline two"), pane: "%3" };
  const parsed = parseMessage(renderMessage(original));
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) {
    expect({ ...parsed.success, number: 1 }).toEqual(original);
  }
});

test("a reply's inReplyTo round-trips through its file", () => {
  const reply = { ...message(2, "subagent", "the answer"), inReplyTo: 1 };
  const rendered = renderMessage(reply);
  expect(rendered).toContain("in_reply_to: 1");
  const parsed = parseMessage(rendered);
  expect(Result.isSuccess(parsed)).toBe(true);
  if (Result.isSuccess(parsed)) {
    expect({ ...parsed.success, number: 2 }).toEqual(reply);
  }
  // A message without attribution writes no line, and an unattributed file has no field.
  expect(renderMessage(message(1, "orchestrator"))).not.toContain("in_reply_to");
  const legacy = parseMessage(renderMessage(message(2, "subagent")));
  expect(Result.isSuccess(legacy) && legacy.success.inReplyTo).toBeUndefined();
});

test("a malformed in_reply_to is absent, not a number", () => {
  const file = (value: string): string => `---\nfrom: subagent\nat: t\nin_reply_to: ${value}\n---\nbody`;
  const parsedOf = (value: string): number | undefined => {
    const parsed = parseMessage(file(value));
    expect(Result.isSuccess(parsed)).toBe(true);
    return Result.isSuccess(parsed) ? parsed.success.inReplyTo : -1;
  };
  expect(parsedOf("1")).toBe(1);
  // An empty value used to become 0, `0x10` became 16, and `-3` stayed negative; all are absent
  // rather than a number that could credit a turn.
  for (const value of ["", "0", "0x10", "-3", "1.5", "abc"]) {
    expect(parsedOf(value)).toBeUndefined();
  }
});

test("a damaged message file is a reason, not a throw", () => {
  expect(Result.isFailure(parseMessage("no frontmatter"))).toBe(true);
  expect(Result.isFailure(parseMessage("---\nfrom: nobody\nat: t\n---\nbody"))).toBe(true);
  expect(Result.isFailure(parseMessage("---\nfrom: user\n---\nbody"))).toBe(true);
});

test("numbering continues past the highest message", () => {
  expect(nextNumber([])).toBe(1);
  expect(nextNumber([message(1, "user"), message(5, "subagent"), message(2, "user")])).toBe(6);
  expect(latestMessage([message(1, "user"), message(5, "subagent")])?.number).toBe(5);
});

test("the view derives presence, activity and interruption", () => {
  const base: SubagentRecord = {
    id: "s",
    changeId: "c",
    profile: "builtin:reviewer",
    label: "Reviewer",
    harness: "pi",
    createdBy: "orchestrator",
    createdAt: "2026-01-01T00:00:00.000Z",
    log: [],
  };
  // Attached and the reporter says working.
  expect(viewOf(base, { attached: true, agentStatus: "working" }, [])).toMatchObject({
    presence: "attached",
    activity: "working",
    interrupted: false,
    awaitingReply: false,
  });
  // A claimed turn is working even while the reporter's last status is a stale waiting.
  expect(
    viewOf({ ...base, inFlight: 1 }, { attached: true, agentStatus: "waiting" }, []),
  ).toMatchObject({
    presence: "attached",
    activity: "working",
    interrupted: false,
    awaitingReply: false,
  });
  // In flight with no live window: interrupted.
  expect(viewOf({ ...base, inFlight: 1 }, { attached: false }, [])).toMatchObject({
    presence: "detached",
    interrupted: true,
  });
  // The latest message is the subagent's, and nothing newer is in the way: a reply is waiting.
  expect(viewOf(base, { attached: true, agentStatus: "waiting" }, [message(2, "subagent")])).toMatchObject({
    awaitingReply: true,
    activity: "idle",
  });
});

/** A record with no live window, for the view cases. */
const record = (): SubagentRecord => ({
  id: "s",
  changeId: "c",
  profile: "builtin:reviewer",
  label: "Reviewer",
  harness: "pi",
  createdBy: "orchestrator",
  createdAt: "2026-01-01T00:00:00.000Z",
  log: [],
});

const reply = (number: number, inReplyTo?: number): SubagentMessage => ({
  ...message(number, "subagent"),
  ...(inReplyTo === undefined ? {} : { inReplyTo }),
});

const attached = { attached: true } as const;

test("awaitingReply tracks the latest inbound turn, not the latest message", () => {
  // An attributed reply to the latest inbound turn, nothing newer pending: parked.
  expect(
    viewOf({ ...record(), deliveredThrough: 1 }, attached, [message(1, "orchestrator"), reply(2, 1)]),
  ).toMatchObject({ awaitingReply: true });

  // The same when an older inbound turn precedes it: the reply names the latest turn.
  expect(
    viewOf({ ...record(), deliveredThrough: 2 }, attached, [
      message(1, "orchestrator"),
      message(2, "orchestrator"),
      reply(3, 2),
    ]),
  ).toMatchObject({ awaitingReply: true });

  // The reply out-numbers a newer inbound turn, so it is the latest message — but the newer turn
  // is still queued, so nothing makes it settled.
  expect(
    viewOf({ ...record(), deliveredThrough: 1 }, attached, [
      message(1, "orchestrator"),
      message(2, "orchestrator"),
      reply(3, 1),
    ]),
  ).toMatchObject({ awaitingReply: false });

  // The same state once the newer turn is claimed (the reported bug): the reply is the latest
  // message while turn 2 is in flight, and must not read as parked.
  expect(
    viewOf({ ...record(), deliveredThrough: 2, inFlight: 2 }, attached, [
      message(1, "orchestrator"),
      message(2, "orchestrator"),
      reply(3, 1),
    ]),
  ).toMatchObject({ awaitingReply: false, activity: "working" });

  // A reply naming a turn the relay never delivered credits nothing: a bogus high number cannot
  // pin readiness, now or for a later turn.
  expect(
    viewOf({ ...record(), deliveredThrough: 1 }, attached, [
      message(1, "orchestrator"),
      reply(2, 9999),
    ]),
  ).toMatchObject({ awaitingReply: false });

  // A legacy reply (no inReplyTo) alone, with nothing pending and nothing in flight: parked.
  expect(
    viewOf({ ...record(), deliveredThrough: 1 }, attached, [message(1, "orchestrator"), reply(2)]),
  ).toMatchObject({ awaitingReply: true });

  // A legacy reply with newer pending work: held back.
  expect(
    viewOf({ ...record(), deliveredThrough: 1 }, attached, [
      message(1, "orchestrator"),
      reply(2),
      message(3, "orchestrator"),
    ]),
  ).toMatchObject({ awaitingReply: false });
});

test("awaitingReply does not depend on the messages being number-sorted", () => {
  // The reply is listed first and out-numbers the inbound: the max-based derivations still see
  // the whole conversation.
  expect(
    viewOf({ ...record(), deliveredThrough: 2 }, attached, [
      reply(3, 2),
      message(2, "orchestrator"),
      message(1, "orchestrator"),
    ]),
  ).toMatchObject({ awaitingReply: true });
  // Unsorted, with the newer inbound still undelivered: held back.
  expect(
    viewOf({ ...record(), deliveredThrough: 1 }, attached, [
      message(2, "orchestrator"),
      reply(3, 1),
      message(1, "orchestrator"),
    ]),
  ).toMatchObject({ awaitingReply: false });
});

test("awaitDecisionOf keeps waiting while the target turn is pending", () => {
  const waiting = {
    ...record(),
    window: "@w",
    deliveredThrough: 0,
    messages: [message(1, "orchestrator")],
  };
  expect(awaitDecisionOf(waiting, attached)).toBeUndefined();
});

test("awaitDecisionOf settles an explicit parked reply before an interrupted newer turn", () => {
  const claimed = {
    ...record(),
    window: "@w",
    deliveredThrough: 2,
    inFlight: 2,
    messages: [message(1, "orchestrator"), message(2, "orchestrator"), reply(3, 1)],
  };
  const detached = { attached: false } as const;
  // The explicit turn's reply is on disk: it wins over the interrupted claim on turn 2.
  expect(awaitDecisionOf(claimed, detached, 1)).toEqual({
    status: "ready",
    reason: "replied",
    turn: 1,
    reply: 3,
  });
  // Without an explicit target, the claim is what interrupts.
  expect(awaitDecisionOf(claimed, detached)).toEqual({ status: "interrupted", turn: 2 });
});

test("awaitDecisionOf labels an interruption with the claimed turn", () => {
  const claimed = {
    ...record(),
    window: "@w",
    deliveredThrough: 2,
    inFlight: 2,
    messages: [message(1, "orchestrator"), message(2, "orchestrator"), message(3, "orchestrator")],
  };
  // Turn 3 is queued but not claimed: the label is the in-flight turn 2, never the latest 3.
  expect(awaitDecisionOf(claimed, { attached: false })).toEqual({ status: "interrupted", turn: 2 });
});

test("awaitDecisionOf calls a cleared window with pending work lost, naming the pending turn", () => {
  const gone = {
    ...record(),
    deliveredThrough: 1,
    messages: [message(1, "orchestrator"), message(2, "orchestrator"), message(3, "orchestrator")],
  };
  // The lowest undelivered inbound is 2, not the latest inbound 3.
  expect(awaitDecisionOf(gone, attached)).toEqual({ status: "lost", turn: 2 });
});

test("awaitDecisionOf returns the default target's attributed reply, legacy reply or idle", () => {
  const attributed = {
    ...record(),
    window: "@w",
    deliveredThrough: 1,
    messages: [message(1, "orchestrator"), reply(2, 1)],
  };
  expect(awaitDecisionOf(attributed, attached)).toEqual({
    status: "ready",
    reason: "replied",
    turn: 1,
    reply: 2,
  });

  const legacy = {
    ...record(),
    window: "@w",
    deliveredThrough: 1,
    messages: [message(1, "orchestrator"), reply(2)],
  };
  expect(awaitDecisionOf(legacy, attached)).toEqual({
    status: "ready",
    reason: "replied",
    turn: 1,
    reply: 2,
  });

  const idle = {
    ...record(),
    window: "@w",
    deliveredThrough: 1,
    messages: [message(1, "orchestrator")],
  };
  expect(awaitDecisionOf(idle, attached)).toEqual({ status: "ready", reason: "idle", turn: 1 });
});

test("awaitDecisionOf does not credit a reply to a turn that was never delivered", () => {
  const bogus = {
    ...record(),
    window: "@w",
    deliveredThrough: 1,
    messages: [message(1, "orchestrator"), message(2, "orchestrator"), reply(3, 9999)],
  };
  // Turn 2 is still pending and the stray attribution credits nothing, so the wait continues.
  expect(awaitDecisionOf(bogus, attached)).toBeUndefined();
});

test("awaitDecisionOf's explicit target is gated by the delivery cursor", () => {
  const messages = [message(1, "orchestrator"), message(2, "orchestrator"), reply(3, 2)];
  // The reply names turn 2, but the relay never delivered it: the explicit target keeps waiting
  // even though pending work does not hold an explicit target back.
  expect(
    awaitDecisionOf({ ...record(), window: "@w", deliveredThrough: 1, messages }, attached, 2),
  ).toBeUndefined();
  // Once the cursor reaches turn 2, the same reply settles the explicit target.
  expect(
    awaitDecisionOf({ ...record(), window: "@w", deliveredThrough: 2, messages }, attached, 2),
  ).toEqual({ status: "ready", reason: "replied", turn: 2, reply: 3 });
});

test("the inbound and answered-through numbers are the highest of each kind", () => {
  expect(latestInboundNumber([])).toBe(0);
  expect(latestInboundNumber([message(1, "orchestrator"), message(4, "subagent")])).toBe(1);
  expect(latestInboundNumber([message(1, "user"), message(5, "orchestrator")])).toBe(5);
  expect(answeredThrough([], 5)).toBe(0);
  expect(
    answeredThrough([message(1, "orchestrator"), { ...message(2, "subagent"), inReplyTo: 1 }], 1),
  ).toBe(1);
  expect(answeredThrough([{ ...message(3, "subagent"), inReplyTo: 2 }], 5)).toBe(2);
  // Only subagent messages attribute; an inbound message's inReplyTo is not a settlement.
  expect(answeredThrough([{ ...message(2, "orchestrator"), inReplyTo: 1 }], 5)).toBe(0);
  // A reply naming a turn the delivery cursor never reached credits nothing and does not raise
  // the max.
  expect(answeredThrough([{ ...message(2, "subagent"), inReplyTo: 9999 }], 1)).toBe(0);
  expect(
    answeredThrough(
      [{ ...message(4, "subagent"), inReplyTo: 3 }, { ...message(5, "subagent"), inReplyTo: 1 }],
      2,
    ),
  ).toBe(1);
});

test("pendingInbound is the lowest undelivered inbound message", () => {
  const record: SubagentRecord = {
    id: "s",
    changeId: "c",
    profile: "builtin:reviewer",
    label: "Reviewer",
    harness: "pi",
    createdBy: "orchestrator",
    createdAt: "2026-01-01T00:00:00.000Z",
    log: [],
  };
  expect(pendingInbound({ ...record, messages: [message(1, "orchestrator")] })?.number).toBe(1);
  expect(
    pendingInbound({ ...record, deliveredThrough: 1, messages: [message(1, "orchestrator")] }),
  ).toBeUndefined();
  // A reply is never pending inbound work, however new it is.
  expect(pendingInbound({ ...record, messages: [message(1, "subagent")] })).toBeUndefined();
});
