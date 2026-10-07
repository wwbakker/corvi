import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import type { PluginInput } from "@opencode-ai/plugin";

import relay, {
  abortableSleep,
  relayLoop,
  subagentOfSession,
  type ExecResult,
  type RelayHarness,
} from "../src/turns.ts";

test("subagentOfSession reads the host-seeded id, and is undefined outside a Corvi session", () => {
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "reviewer-1" })).toBe("reviewer-1");
  expect(subagentOfSession({ CORVI_SUBAGENT_ID: "" })).toBeUndefined();
  expect(subagentOfSession({})).toBeUndefined();
  expect(subagentOfSession({ TMUX_PANE: "%3" })).toBeUndefined();
});

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
  // The submitted number is relayed as the turn the reply answers.
  const args = turns[0] ?? [];
  expect(args[args.indexOf("--in-reply-to") + 1]).toBe("4");
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

/** Poll a condition, for the wiring test that awaits an async start. */
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

/** A fake `BunShell`: each call counts an exec and resolves to the fixed result. */
const makeShell = (onExec: () => { exitCode: number; stdout: Buffer; stderr: Buffer }): unknown =>
  (): Record<string, unknown> => {
    const result = onExec();
    const thenable: Record<string, unknown> = {
      ...result,
      quiet: () => thenable,
      nothrow: () => thenable,
      then: (resolve: (value: unknown) => void, reject?: (error: unknown) => void) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return thenable;
  };

test("the plugin's dispose aborts its relay", async () => {
  const saved = process.env.CORVI_SUBAGENT_ID;
  process.env.CORVI_SUBAGENT_ID = "sub-dispose";
  try {
    let execs = 0;
    const input = {
      $: makeShell(() => {
        execs += 1;
        return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("down") };
      }),
      client: { session: { promptAsync: async () => ({}) } },
    } as unknown as PluginInput;
    const hooks = await relay.server(input);
    await until(() => execs >= 1);
    expect(typeof hooks.dispose).toBe("function");

    // A failing poll backs off; dispose must cut that short so the old runtime stops polling.
    const before = execs;
    await hooks.dispose?.();
    await Bun.sleep(1500); // longer than the first backoff
    expect(execs).toBe(before);
  } finally {
    if (saved === undefined) delete process.env.CORVI_SUBAGENT_ID;
    else process.env.CORVI_SUBAGENT_ID = saved;
  }
}, 10_000);
