import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import turns, {
  abortableSleep,
  relayLoop,
  subagentOfSession,
  type ExecResult,
  type RelayHarness,
} from "../src/turns.ts";

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

/** Poll a condition, for the wiring tests that await an async start. */
const until = async (read: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!read() && Date.now() < deadline) await Bun.sleep(10);
};

test("an abort cuts the backoff short and stops the relay", async () => {
  const controller = new AbortController();
  let nexts = 0;
  const harness: RelayHarness = {
    exec: async (args) => {
      if (args[1] === "next") nexts += 1;
      return { code: 1, stdout: "", stderr: "down" };
    },
    submit: async () => {},
    settled: async () => "never",
    // The wiring's sleep, not a plain timer: an external abort must cut the backoff short. A plain
    // timer would let the loop return only after the backoff (the old `while` would pass too).
    sleep: (ms) => abortableSleep(ms, controller.signal),
    signal: controller.signal,
    log: () => {},
  };
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await relayLoop("s1", harness);
  expect(Date.now() - started).toBeLessThan(300);
  expect(nexts).toBe(1);
});

test("a poll that resolves after the abort is not submitted", async () => {
  const controller = new AbortController();
  const submitted: string[] = [];
  let release: (() => void) | undefined;
  const harness: RelayHarness = {
    exec: async (args) => {
      if (args[1] !== "next") return { code: 0, stdout: "{}", stderr: "" };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        code: 0,
        stdout: JSON.stringify({ status: "message", message: { number: 1, body: "late" } }),
        stderr: "",
      };
    },
    submit: async (text) => {
      submitted.push(text);
    },
    settled: async () => "reply",
    sleep: async () => {},
    signal: controller.signal,
    log: () => {},
  };
  const loop = relayLoop("s1", harness);
  await until(() => release !== undefined);
  controller.abort();
  release?.();
  await loop;
  // The server has claimed the message; a torn-down runtime must not submit it.
  expect(submitted).toEqual([]);
});

test("relaying does not accumulate abort listeners", async () => {
  const controller = new AbortController();
  let polls = 0;
  const harness: RelayHarness = {
    exec: async (args) => {
      if (args[1] !== "next") return { code: 0, stdout: "{}", stderr: "" };
      polls += 1;
      // Yield to the macrotask queue each poll, or the test's own timer would starve.
      await Bun.sleep(0);
      return { code: 0, stdout: JSON.stringify({ status: "none" }), stderr: "" };
    },
    submit: async () => {},
    settled: async () => undefined,
    sleep: async () => {},
    signal: controller.signal,
    log: () => {},
  };
  const loop = relayLoop("s1", harness);
  await until(() => polls >= 20);
  // One listener for the relay, not one per poll.
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  await loop;
});

test("aborting while a run is in flight leaves the loop rather than parking", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const harness: RelayHarness = {
    exec: async (args) => {
      calls.push(args[1] ?? "");
      if (args[1] === "next") {
        return { code: 0, stdout: JSON.stringify({ status: "message", message: { number: 1, body: "hi" } }), stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
    submit: async () => {},
    settled: () => new Promise<undefined>(() => {}), // never settles
    sleep: async () => {},
    signal: controller.signal,
    log: () => {},
  };
  setTimeout(() => controller.abort(), 20);
  await relayLoop("s1", harness);
  // The loop left `settled` on abort instead of parking, and did not relay a reply nobody wants.
  expect(calls.filter((call) => call === "turn")).toHaveLength(0);
}, 10_000);

/** A fake pi runtime: its own handlers, its own parked `next`, its own poll count. Two of these
 * stand in for a `/reload`, which invokes the extension factory again for a fresh runtime. */
const runtime = (options: { readonly execRejects?: boolean } = {}): {
  readonly pi: ExtensionAPI;
  readonly start: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly nexts: () => number;
  readonly releaseNext: (result: ExecResult) => void;
  readonly releaseParked: (index: number, result: ExecResult) => void;
} => {
  const handlers = new Map<string, (() => void | Promise<void>)[]>();
  let nexts = 0;
  const parked: ((result: ExecResult) => void)[] = [];
  const pi = {
    on: (event: string, handler: () => void | Promise<void>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    exec: async (_command: string, args: readonly string[]): Promise<ExecResult> => {
      if (options.execRejects === true) throw new Error("exec exploded");
      if (args[1] === "next") {
        nexts += 1;
        return new Promise<ExecResult>((resolve) => {
          parked.push(resolve);
        });
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
    sendUserMessage: async () => undefined,
  } as unknown as ExtensionAPI;
  const emit = async (event: string): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler();
  };
  return {
    pi,
    start: () => emit("session_start"),
    shutdown: () => emit("session_shutdown"),
    nexts: () => nexts,
    releaseNext: (result) => {
      parked[parked.length - 1]?.(result);
    },
    releaseParked: (index, result) => {
      parked[index]?.(result);
    },
  };
};

test("a reload starts one fresh relay and stops the old one", async () => {
  const saved = process.env.CORVI_SUBAGENT_ID;
  process.env.CORVI_SUBAGENT_ID = "sub-reload";
  try {
    const first = runtime();
    turns(first.pi);
    await first.start();
    await until(() => first.nexts() === 1);

    // `/reload`: the old runtime shuts down, then a fresh runtime starts.
    await first.shutdown();
    const second = runtime();
    turns(second.pi);
    await second.start();
    await until(() => second.nexts() === 1);

    // Release the old loop's parked poll with a failure: aborted, it must not poll again, even
    // after the first backoff would have elapsed.
    first.releaseNext({ code: 1, stdout: "", stderr: "gone" });
    await Bun.sleep(1200);
    expect(first.nexts()).toBe(1);
    expect(second.nexts()).toBe(1);
  } finally {
    if (saved === undefined) delete process.env.CORVI_SUBAGENT_ID;
    else process.env.CORVI_SUBAGENT_ID = saved;
  }
});

test("a start while a loop is live supersedes it, leaving one relay", async () => {
  const saved = process.env.CORVI_SUBAGENT_ID;
  process.env.CORVI_SUBAGENT_ID = "sub-supersede";
  try {
    const fake = runtime();
    turns(fake.pi);
    await fake.start();
    await until(() => fake.nexts() === 1);

    // A second start (a session replacement, whose shutdown may not have arrived yet) must
    // supersede, not be dropped: the session would otherwise be relay-less until the next reload.
    await fake.start();
    await until(() => fake.nexts() === 2);
    // The second start ran a fresh loop rather than being dropped.
    expect(fake.nexts()).toBe(2);

    // Release the superseded loop's poll with a failure: aborted, it must not poll again, even
    // after the first backoff would have elapsed.
    fake.releaseParked(0, { code: 1, stdout: "", stderr: "gone" });
    await Bun.sleep(1200);
    expect(fake.nexts()).toBe(2);
  } finally {
    if (saved === undefined) delete process.env.CORVI_SUBAGENT_ID;
    else process.env.CORVI_SUBAGENT_ID = saved;
  }
}, 10_000);

test("a harness whose exec rejects does not become an unhandled rejection", async () => {
  const saved = process.env.CORVI_SUBAGENT_ID;
  process.env.CORVI_SUBAGENT_ID = "sub-reject";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const fake = runtime({ execRejects: true });
    turns(fake.pi);
    await fake.start();
    await Bun.sleep(100); // give an unhandled rejection a chance to surface
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    if (saved === undefined) delete process.env.CORVI_SUBAGENT_ID;
    else process.env.CORVI_SUBAGENT_ID = saved;
  }
  expect(unhandled).toEqual([]);
}, 10_000);
