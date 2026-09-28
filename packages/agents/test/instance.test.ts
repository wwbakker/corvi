import { expect, test } from "bun:test";
import { Either } from "effect";

import {
  latestMessage,
  messageFileOf,
  messageFileName,
  nextNumber,
  parseMessage,
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
});

test("a message round-trips through its file", () => {
  const original = { ...message(1, "orchestrator", "line one\nline two"), pane: "%3" };
  const parsed = parseMessage(renderMessage(original));
  expect(Either.isRight(parsed)).toBe(true);
  if (Either.isRight(parsed)) {
    expect({ ...parsed.right, number: 1 }).toEqual(original);
  }
});

test("a damaged message file is a reason, not a throw", () => {
  expect(Either.isLeft(parseMessage("no frontmatter"))).toBe(true);
  expect(Either.isLeft(parseMessage("---\nfrom: nobody\nat: t\n---\nbody"))).toBe(true);
  expect(Either.isLeft(parseMessage("---\nfrom: user\n---\nbody"))).toBe(true);
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
  // In flight with no live window: interrupted.
  expect(viewOf({ ...base, inFlight: 1 }, { attached: false }, [])).toMatchObject({
    presence: "detached",
    interrupted: true,
  });
  // The latest message is the subagent's: a reply is waiting.
  expect(viewOf(base, { attached: true, agentStatus: "waiting" }, [message(2, "subagent")])).toMatchObject({
    awaitingReply: true,
    activity: "idle",
  });
});
