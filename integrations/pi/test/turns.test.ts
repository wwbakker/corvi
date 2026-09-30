import { expect, test } from "bun:test";

import { relayLoop, subagentOfSession, type ExecResult, type RelayHarness } from "../src/turns.ts";

test("subagentOfSession reads the host-seeded id, and is undefined outside a Corvi session", () => {
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "reviewer-1" })).toBe("reviewer-1");
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "  reviewer-1  " })).toBe("reviewer-1");
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "" })).toBeUndefined();
  expect(subagentOfSession({})).toBeUndefined();
  // A tmux pane without the host seed is not a subagent: the tmux fallback is gone, and the relay
  // stays quiet rather than guessing.
  expect(subagentOfSession({ TMUX_PANE: "%3" })).toBeUndefined();
});

/** A harness driven by this test: `next` answers a scripted queue, `turn` records, and `settled`
 * aborts the loop after one turn so it terminates. */
const scripted = (options: {
  readonly nexts: readonly unknown[];
  readonly turnFailsOnce?: boolean;
  readonly reply?: string;
}): { readonly harness: RelayHarness; readonly submitted: string[]; readonly turns: string[][]; } => {
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
      if (options.turnFailsOnce && turnAttempts === 1) {
        return { code: 1, stdout: "", stderr: "server down" };
      }
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
      settled: async () => options.reply ?? "Looks good",
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
    nexts: [{ status: "message", message: { number: 3, body: "Review it" } }],
  });
  await relayLoop("s1", harness);
  expect(submitted).toEqual(["Review it"]);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toContain("--subagent");
  expect(turns[0]).toContain("s1");
  expect(turns[0]).toContain("--idempotency-key");
  expect(turns[0]).toContain("turn-3");
  expect(turns[0]?.at(-1)).toBe("Looks good");
});

test("the turn is retried after a failed relay", async () => {
  const { harness, turns } = scripted({
    nexts: [{ status: "message", message: { number: 1, body: "hi" } }],
    turnFailsOnce: true,
  });
  await relayLoop("s1", harness);
  expect(turns).toHaveLength(2); // the failure and the retry
});

test("an interrupted turn is not submitted", async () => {
  const { harness, submitted } = scripted({
    nexts: [
      { status: "interrupted" },
      { status: "message", message: { number: 2, body: "later" } },
    ],
  });
  await relayLoop("s1", harness);
  expect(submitted).toEqual(["later"]);
});

test("a settled run with no text still closes the turn", async () => {
  const { harness, turns } = scripted({
    nexts: [{ status: "message", message: { number: 1, body: "hi" } }],
    reply: "",
  });
  await relayLoop("s1", harness);
  expect(turns[0]?.at(-1)).toBe("(the run ended without a reply)");
});

test("a reply that begins with a dash is data, not a flag", async () => {
  const { harness, turns } = scripted({
    nexts: [{ status: "message", message: { number: 1, body: "hi" } }],
    reply: "-- not a flag",
  });
  await relayLoop("s1", harness);
  const args = turns[0] ?? [];
  const separator = args.indexOf("--");
  expect(separator).toBeGreaterThan(-1);
  expect(args[separator + 1]).toBe("-- not a flag");
});
