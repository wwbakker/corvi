import { test, expect } from "bun:test";

import type { PluginInput } from "@opencode-ai/plugin";

import reporter, { firstSentence, trackAnswer } from "../src/agent-state.ts";

/** A fake opencode whose `$` records each `corvi status` call. */
const fakeInput = (): { readonly input: PluginInput; readonly statuses: string[] } => {
  const statuses: string[] = [];
  const $ = (_strings: TemplateStringsArray, ...values: unknown[]): Promise<void> => {
    const args = (values[0] as string[]) ?? [];
    statuses.push(args[0] === "status" ? (args[1] ?? "") : "");
    return Promise.resolve();
  };
  return { input: { $ } as unknown as PluginInput, statuses };
};

const withStatusEnv = async (heartbeat: string, work: () => Promise<void>): Promise<void> => {
  const savedSession = process.env.CORVI_SESSION_ID;
  const savedHeartbeat = process.env.CORVI_STATUS_HEARTBEAT_MS;
  process.env.CORVI_SESSION_ID = "w-heartbeat";
  process.env.CORVI_STATUS_HEARTBEAT_MS = heartbeat;
  try {
    await work();
  } finally {
    if (savedSession === undefined) delete process.env.CORVI_SESSION_ID;
    else process.env.CORVI_SESSION_ID = savedSession;
    if (savedHeartbeat === undefined) delete process.env.CORVI_STATUS_HEARTBEAT_MS;
    else process.env.CORVI_STATUS_HEARTBEAT_MS = savedHeartbeat;
  }
};

test("a working reporter re-publishes on the heartbeat and stops when it goes idle", async () => {
  await withStatusEnv("30", async () => {
    const { input, statuses } = fakeInput();
    const hooks = await reporter.server(input);
    // The opening state is waiting, published once.
    expect(statuses).toEqual(["waiting"]);
    await hooks.event!({
      event: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "user", summary: false } } },
    } as never);
    expect(statuses.at(-1)).toBe("working");
    await Bun.sleep(120); // several heartbeats
    expect(statuses.filter((status) => status === "working").length).toBeGreaterThanOrEqual(3);
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never);
    expect(statuses.at(-1)).toBe("waiting");
    const after = statuses.length;
    await Bun.sleep(120);
    expect(statuses.length).toBe(after); // the heartbeat stopped
    await hooks.dispose?.();
  });
}, 10_000);

test("dispose stops the heartbeat", async () => {
  await withStatusEnv("30", async () => {
    const { input, statuses } = fakeInput();
    const hooks = await reporter.server(input);
    await hooks.event!({
      event: { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "user", summary: false } } },
    } as never);
    await Bun.sleep(80);
    await hooks.dispose?.();
    const after = statuses.length;
    await Bun.sleep(120);
    expect(statuses.length).toBe(after);
  });
}, 10_000);

/**
 * The opencode reporter's pure half: the notification sentence and the shape of one answer as
 * opencode writes it (text parts accumulating over `message.part.updated` events). The rest is
 * window facts and opencode events.
 */
test("the notification sentence is the first one, on a single line", () => {
  expect(firstSentence("I fixed the layout. Then I pushed.")).toBe("I fixed the layout.");
  expect(firstSentence("line one\n\nline two")).toBe("line one line two");
  // An answer that never ends a sentence is still said, just cut short and marked.
  const long = "a".repeat(300);
  expect(firstSentence(long)).toHaveLength(180);
  expect(firstSentence(long).endsWith("…")).toBe(true);
});

test("an answer is its text parts, joined in the order they appeared", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "first");
  answer.addPart("m1", "p2", "second");
  expect(answer.answer()).toBe("first second");
});

test("a resent part replaces itself where it stands", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "first");
  answer.addPart("m1", "p2", "second");
  answer.addPart("m1", "p1", "FIRST");
  expect(answer.answer()).toBe("FIRST second");
});

test("only the current message counts, and ignored parts say nothing", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "mine");
  answer.addPart("m2", "p2", "some other message");
  answer.addPart("m1", "p3", "hidden", true);
  expect(answer.answer()).toBe("mine");
  // A new message is a new answer; the old one is gone.
  answer.begin("m2");
  expect(answer.answer()).toBe("");
  answer.addPart("m2", "p2", "the new one");
  expect(answer.answer()).toBe("the new one");
});

test("clearing forgets even the message being written", () => {
  const answer = trackAnswer();
  answer.begin("m1");
  answer.addPart("m1", "p1", "half an answer");
  answer.clear();
  answer.addPart("m1", "p1", "the rest");
  expect(answer.answer()).toBe("");
});
