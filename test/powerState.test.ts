import { describe, expect, test } from "bun:test";

import { advance, type PowerState } from "../apps/server/src/power/server/state.ts";

const COUNTDOWN = 60_000;
const NOW = 1_000_000;

const counting = (): PowerState => ({
  phase: "counting-down",
  deadline: new Date(NOW + COUNTDOWN).toISOString(),
});

describe("power state transitions", () => {
  test("disarmed never changes and never fires", () => {
    const disarmed: PowerState = { phase: "disarmed", error: "an old failure" };
    expect(advance(disarmed, true, NOW, COUNTDOWN)).toEqual({ state: disarmed, fire: false });
    expect(advance(disarmed, false, NOW, COUNTDOWN)).toEqual({ state: disarmed, fire: false });
  });

  test("armed and not quiet stays armed and drops any deadline", () => {
    expect(advance({ phase: "armed", deadline: "stale" }, false, NOW, COUNTDOWN)).toEqual({
      state: { phase: "armed" },
      fire: false,
    });
  });

  test("armed and quiet starts the countdown at now + countdownMs", () => {
    expect(advance({ phase: "armed" }, true, NOW, COUNTDOWN)).toEqual({
      state: { phase: "counting-down", deadline: new Date(NOW + COUNTDOWN).toISOString() },
      fire: false,
    });
  });

  test("a busy edge during the countdown cancels back to armed and stays armed", () => {
    expect(advance(counting(), false, NOW + 1, COUNTDOWN)).toEqual({
      state: { phase: "armed" },
      fire: false,
    });
  });

  test("quiet before the deadline keeps counting down and does not fire", () => {
    const state = counting();
    expect(advance(state, true, NOW + COUNTDOWN - 1, COUNTDOWN)).toEqual({ state, fire: false });
  });

  test("quiet at the deadline fires", () => {
    const state = counting();
    expect(advance(state, true, NOW + COUNTDOWN, COUNTDOWN)).toEqual({ state, fire: true });
  });

  test("a countdown with no deadline never fires", () => {
    const state: PowerState = { phase: "counting-down" };
    expect(advance(state, true, NOW, COUNTDOWN)).toEqual({ state, fire: false });
  });
});
