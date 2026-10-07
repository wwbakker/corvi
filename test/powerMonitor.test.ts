import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";

import type { PowerAgent } from "@corvi/contracts/power";
import { CliError } from "@corvi/contracts/errors";
import { SubagentStoreError } from "@corvi/agents/node";
import type { PowerShape } from "../apps/server/src/capabilities/power.ts";
import { makeMonitor, type Monitor } from "../apps/server/src/power/server/monitor.ts";

const COUNTDOWN = 1_000;

const working = (label: string): PowerAgent => ({ label, working: true });

/** A monitor whose agent list, read failure and clock a test controls, with the power command
 * counted instead of run. No timers: the clock only moves when the test moves it. */
const harness = (
  power: PowerShape,
): {
  monitor: Monitor;
  setAgents: (agents: readonly PowerAgent[]) => void;
  setFailing: (failing: boolean) => void;
  setNow: (now: number) => void;
  reads: () => number;
} => {
  let agents: readonly PowerAgent[] = [];
  let failing = false;
  let now = 0;
  let reads = 0;
  const monitor = makeMonitor({
    agents: () => {
      reads += 1;
      return failing ? Effect.fail(new Error("agent read failed")) : Effect.succeed(agents);
    },
    power,
    now: () => now,
    countdownMs: COUNTDOWN,
  });
  return {
    monitor,
    setAgents: (next) => {
      agents = next;
    },
    setFailing: (next) => {
      failing = next;
    },
    setNow: (next) => {
      now = next;
    },
    reads: () => reads,
  };
};

const counting = (): PowerShape & { calls: number[] } => {
  const calls: number[] = [];
  return {
    calls,
    powerOff: () =>
      Effect.sync(() => {
        calls.push(1);
      }),
  };
};

test("quiet through the countdown fires the power command once and disarms", async () => {
  const power = counting();
  const h = harness(power);

  await Effect.runPromise(h.monitor.arm());
  await Effect.runPromise(h.monitor.tick());
  expect((await Effect.runPromise(h.monitor.state())).phase).toBe("counting-down");

  h.setNow(COUNTDOWN - 1);
  await Effect.runPromise(h.monitor.tick());
  expect(power.calls.length).toBe(0);

  h.setNow(COUNTDOWN);
  await Effect.runPromise(h.monitor.tick());
  expect(power.calls.length).toBe(1);

  const state = await Effect.runPromise(h.monitor.state());
  expect(state.phase).toBe("disarmed");
  expect(state.error).toBeUndefined();
});

test("a busy edge cancels the countdown but stays armed, and quiet re-arms it", async () => {
  const power = counting();
  const h = harness(power);

  await Effect.runPromise(h.monitor.arm());
  await Effect.runPromise(h.monitor.tick()); // armed -> counting-down at 1000
  h.setAgents([working("pi")]);
  h.setNow(500);
  await Effect.runPromise(h.monitor.tick());

  let state = await Effect.runPromise(h.monitor.state());
  expect(state.phase).toBe("armed");
  expect(state.deadline).toBeUndefined();
  expect(power.calls.length).toBe(0);

  // Quiet again: a fresh countdown from the new now, and the deadline that follows from it.
  h.setAgents([]);
  h.setNow(600);
  await Effect.runPromise(h.monitor.tick());
  state = await Effect.runPromise(h.monitor.state());
  expect(state.phase).toBe("counting-down");
  expect(state.deadline).toBe(new Date(600 + COUNTDOWN).toISOString());

  h.setNow(600 + COUNTDOWN);
  await Effect.runPromise(h.monitor.tick());
  expect(power.calls.length).toBe(1);
});

test("a failed power command records its message and disarms; a new arm clears it", async () => {
  const failure = new CliError({
    message: "Interactive authentication required.",
    tool: "systemctl",
    command: "systemctl poweroff",
    stderr: "Interactive authentication required.",
    exitCode: 1,
  });
  const power: PowerShape = { powerOff: () => Effect.fail(failure) };
  const h = harness(power);

  await Effect.runPromise(h.monitor.arm());
  await Effect.runPromise(h.monitor.tick());
  h.setNow(COUNTDOWN);
  await Effect.runPromise(h.monitor.tick());

  const state = await Effect.runPromise(h.monitor.state());
  expect(state.phase).toBe("disarmed");
  expect(state.error).toBe("Interactive authentication required.");

  await Effect.runPromise(h.monitor.arm());
  const rearmed = await Effect.runPromise(h.monitor.state());
  expect(rearmed.phase).toBe("armed");
  expect(rearmed.error).toBeUndefined();
});

test("a failed agent read skips the tick and never fires", async () => {
  const power = counting();
  const h = harness(power);

  await Effect.runPromise(h.monitor.arm());
  await Effect.runPromise(h.monitor.tick()); // counting-down
  h.setFailing(true);
  h.setNow(COUNTDOWN);
  await Effect.runPromise(h.monitor.tick());

  expect(power.calls.length).toBe(0);
  // The state was left exactly as it was: a successful read still shows the countdown running.
  h.setFailing(false);
  expect((await Effect.runPromise(h.monitor.state())).phase).toBe("counting-down");
});

test("ticking while disarmed does nothing, not even a read", async () => {
  const power = counting();
  const h = harness(power);
  await Effect.runPromise(h.monitor.tick());
  expect(h.reads()).toBe(0);
  expect(power.calls.length).toBe(0);
});

test("two overlapping ticks fire the power command only once", async () => {
  const gate = await Effect.runPromise(Deferred.make<void>());
  const started = await Effect.runPromise(Deferred.make<void>());
  let calls = 0;
  let now = 0;
  const monitor = makeMonitor({
    agents: () => Effect.succeed([] as readonly PowerAgent[]),
    power: {
      powerOff: () =>
        Effect.sync(() => {
          calls += 1;
        })
          .pipe(Effect.andThen(Deferred.succeed(started, undefined)))
          .pipe(Effect.andThen(Deferred.await(gate))),
    },
    now: () => now,
    countdownMs: COUNTDOWN,
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* monitor.arm();
      yield* monitor.tick(); // counting-down
      now = COUNTDOWN;
      // The first tick claims the fire and parks on the gate; the second runs while it is
      // parked and must find nothing to fire.
      const first = yield* Effect.forkChild(monitor.tick());
      yield* Deferred.await(started);
      yield* monitor.tick();
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
    }),
  );
  expect(calls).toBe(1);
});

test("a defective power command is recorded, disarms, and never fires twice", async () => {
  let calls = 0;
  const power: PowerShape = {
    powerOff: () =>
      Effect.sync(() => {
        calls += 1;
      }).pipe(Effect.andThen(Effect.die(new Error("spawn failed")))),
  };
  const h = harness(power);

  await Effect.runPromise(h.monitor.arm());
  await Effect.runPromise(h.monitor.tick());
  h.setNow(COUNTDOWN);
  await Effect.runPromise(h.monitor.tick());

  expect(calls).toBe(1);
  const state = await Effect.runPromise(h.monitor.state());
  expect(state.phase).toBe("disarmed");
  expect(state.error).toContain("spawn failed");

  // A defect disarms like a typed failure: the next tick is a no-op, not a retry loop.
  await Effect.runPromise(h.monitor.tick());
  expect(calls).toBe(1);
});

test("a strict subagent read failure skips the tick and never fires", async () => {
  let calls = 0;
  let failing = true;
  const storeError = new SubagentStoreError({ operation: "read", message: "subagents" });
  const monitor = makeMonitor({
    agents: () =>
      failing ? Effect.fail(storeError) : Effect.succeed([] as readonly PowerAgent[]),
    power: {
      powerOff: () =>
        Effect.sync(() => {
          calls += 1;
        }),
    },
    now: () => COUNTDOWN,
    countdownMs: COUNTDOWN,
  });

  await Effect.runPromise(monitor.arm());
  await Effect.runPromise(monitor.tick());
  expect(calls).toBe(0);

  // The arm state was left as it was: the tick was skipped, not counted as quiet.
  failing = false;
  const state = await Effect.runPromise(monitor.state());
  expect(state.phase).toBe("armed");
});

test("arm, disarm and a transition each fire the change hook", async () => {
  const changes: number[] = [];
  let now = 0;
  const monitor = makeMonitor({
    agents: () => Effect.succeed([] as readonly PowerAgent[]),
    power: counting(),
    now: () => now,
    countdownMs: COUNTDOWN,
    onChange: () => {
      changes.push(1);
    },
  });

  await Effect.runPromise(monitor.arm());
  expect(changes.length).toBe(1);

  await Effect.runPromise(monitor.tick()); // armed -> counting-down
  expect(changes.length).toBe(2);

  // A tick that changes nothing (still counting, before the deadline) says nothing.
  now = COUNTDOWN - 1;
  await Effect.runPromise(monitor.tick());
  expect(changes.length).toBe(2);

  await Effect.runPromise(monitor.disarm());
  expect(changes.length).toBe(3);
});
