import { test, expect } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import reporter, { firstSentence, textOf } from "../src/agent-state.ts";

/** A fake pi whose events this test drives and whose `corvi status` calls it records. */
const fakePi = (): {
  readonly pi: ExtensionAPI;
  readonly emit: (event: string) => Promise<void>;
  readonly statuses: string[];
} => {
  const handlers = new Map<string, (() => void | Promise<void>)[]>();
  const statuses: string[] = [];
  const pi = {
    on: (event: string, handler: () => void | Promise<void>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    exec: async (_command: string, args: readonly string[]) => {
      statuses.push(args[0] === "status" ? (args[1] ?? "") : args.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
    getSessionName: () => undefined,
  } as unknown as ExtensionAPI;
  return {
    pi,
    statuses,
    emit: async (event) => {
      for (const handler of handlers.get(event) ?? []) await handler();
    },
  };
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

test("a working reporter re-publishes on the heartbeat and stops when it settles", async () => {
  await withStatusEnv("30", async () => {
    const { pi, emit, statuses } = fakePi();
    reporter(pi);
    await emit("agent_start");
    expect(statuses).toEqual(["working"]);
    await Bun.sleep(120); // several heartbeats
    expect(statuses.filter((status) => status === "working").length).toBeGreaterThanOrEqual(3);
    await emit("agent_settled");
    expect(statuses.at(-1)).toBe("waiting");
    const after = statuses.length;
    await Bun.sleep(120);
    expect(statuses.length).toBe(after); // the heartbeat stopped
  });
}, 10_000);

test("session shutdown stops the heartbeat", async () => {
  await withStatusEnv("30", async () => {
    const { pi, emit, statuses } = fakePi();
    reporter(pi);
    await emit("agent_start");
    await Bun.sleep(80);
    await emit("session_shutdown");
    const after = statuses.length;
    await Bun.sleep(120);
    expect(statuses.length).toBe(after);
  });
}, 10_000);

test("the notification sentence is the first one, on a single line", () => {
  expect(firstSentence("I fixed the layout. Then I pushed.")).toBe("I fixed the layout.");
  expect(firstSentence("line one\n\nline two")).toBe("line one line two");
  // An answer that never ends a sentence is still said, just cut short and marked.
  const long = "a".repeat(300);
  expect(firstSentence(long)).toHaveLength(180);
  expect(firstSentence(long).endsWith("…")).toBe(true);
});

test("only an assistant's text is read, and nothing else", () => {
  expect(
    textOf({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "toolCall", name: "bash" },
      ],
    }),
  ).toBe("first second");
  expect(textOf({ role: "user", content: [{ type: "text", text: "hello" }] })).toBe("");
  expect(textOf({ role: "assistant", content: "not an array" })).toBe("");
  expect(textOf(undefined)).toBe("");
});
