import { expect, test } from "bun:test";

import { relayLoop, type ExecResult, type RelayHarness } from "../src/turns.ts";

/** A harness driven by this test, the same shape the pi relay test uses: `next` answers a
 * scripted queue, `turn` records, and `settled` aborts the loop after one turn. */
const scripted = (options: {
  readonly nexts: readonly unknown[];
  readonly turnFailsOnce?: boolean;
  readonly reply?: string;
}): { readonly harness: RelayHarness; readonly submitted: string[]; readonly turns: string[][] } => {
  const controller = new AbortController();
  const submitted: string[] = [];
  const turns: string[][] = [];
  let nextIndex = 0;
  let turnAttempts = 0;

  const exec = async (args: readonly string[]): Promise<ExecResult> => {
    if (args[0] === "subagent" && args[1] === "next") {
      const answer = options.nexts[Math.min(nextIndex, options.nexts.length - 1)];
      nextIndex += 1;
      return { code: 0, stdout: JSON.stringify(answer), stderr: "" };
    }
    if (args[0] === "subagent" && args[1] === "turn") {
      turnAttempts += 1;
      turns.push([...args]);
      if (options.turnFailsOnce && turnAttempts === 1) return { code: 1, stdout: "", stderr: "down" };
      controller.abort();
      return { code: 0, stdout: "{}", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };

  return {
    harness: {
      exec,
      submit: (text) => {
        submitted.push(text);
      },
      settled: async () => options.reply ?? "done",
      sleep: async () => {},
      signal: controller.signal,
      log: () => {},
    },
    submitted,
    turns,
  };
};

test("a relayed loop submits an inbound message and relays the settled reply", async () => {
  const { harness, submitted, turns } = scripted({
    nexts: [{ status: "message", message: { number: 4, body: "Review it" } }],
  });
  await relayLoop("s1", harness);
  expect(submitted).toEqual(["Review it"]);
  expect(turns[0]).toContain("turn-4");
  expect(turns[0]?.at(-1)).toBe("done");
});

test("the turn is retried after a failed relay", async () => {
  const { harness, turns } = scripted({
    nexts: [{ status: "message", message: { number: 1, body: "hi" } }],
    turnFailsOnce: true,
  });
  await relayLoop("s1", harness);
  expect(turns).toHaveLength(2);
});
