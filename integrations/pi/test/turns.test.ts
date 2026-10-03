import { expect, test } from "bun:test";

import { relayLoop, subagentOfSession, type ExecResult, type RelayHarness } from "../src/turns.ts";

test("subagentOfSession reads the host-seeded id, and is undefined outside a Corvi session", () => {
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "reviewer-1" })).toBe("reviewer-1");
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "  reviewer-1  " })).toBe("reviewer-1");
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "" })).toBeUndefined();
  expect(subagentOfSession({})).toBeUndefined();
  // A session without the host seed is not a subagent: the relay stays quiet rather than guessing.
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

type NextStep =
  | { readonly status: "message"; readonly message: { readonly number: number; readonly body: string } }
  | { readonly status: "interrupted" | "none" }
  | "fail";

/** A harness that records its sleeps and logs and answers `next` from a script; the loop aborts on
 * the first `turn`. The jitter is fixed so the delays are exact. */
const recording = (
  script: readonly NextStep[],
  random = 0.5,
): { readonly harness: RelayHarness; readonly sleeps: number[]; readonly logs: string[] } => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const logs: string[] = [];
  let index = 0;
  return {
    harness: {
      exec: async (args) => {
        if (args[0] === "subagent" && args[1] === "next") {
          const step = script[Math.min(index, script.length - 1)];
          index += 1;
          if (step === "fail") return { code: 1, stdout: "", stderr: "no server" };
          return { code: 0, stdout: JSON.stringify(step ?? { status: "none" }), stderr: "" };
        }
        controller.abort();
        return { code: 0, stdout: "{}", stderr: "" };
      },
      submit: async () => {},
      settled: async () => "done",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => random,
      signal: controller.signal,
      log: (message) => logs.push(message),
    },
    sleeps,
    logs,
  };
};

test("a failed next backs off exponentially with equal jitter and caps", async () => {
  const { harness, sleeps, logs } = recording([
    "fail",
    "fail",
    "fail",
    "fail",
    "fail",
    "fail",
    "fail",
    { status: "none" },
    { status: "message", message: { number: 1, body: "hi" } },
  ]);
  await relayLoop("s1", harness);
  // Equal jitter at 0.5 is 75% of the cap: 750, 1500, 3000, 6000, 12000, then the 30s cap.
  expect(sleeps).toEqual([750, 1500, 3000, 6000, 12000, 22500, 22500]);
  // One failure streak logs once, not once per attempt.
  expect(logs).toHaveLength(1);
});

test("a success resets the backoff, and an interrupted turn backs off too", async () => {
  const { harness, sleeps } = recording([
    "fail",
    { status: "none" },
    { status: "interrupted" },
    "fail",
    { status: "message", message: { number: 1, body: "hi" } },
  ]);
  await relayLoop("s1", harness);
  // fail (attempt 0); the `none` resets; interrupted (attempt 0); fail (attempt 1).
  expect(sleeps).toEqual([750, 750, 1500]);
});
