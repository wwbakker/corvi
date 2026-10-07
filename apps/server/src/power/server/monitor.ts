/** The power monitor: the single owner of a machine's arm state, its countdown, and the one
 * power command.
 *
 * It reads the same agent list the control shows (`agents`, injected), decides with the pure
 * `advance`, and runs `Power` when the countdown elapses. It is deliberately not a route and not
 * a page: the caller starts it and ticks it, so the countdown lives with the server, not with a
 * connected browser.
 *
 * The caller is expected to tick one monitor (one fiber). Even so, the fire is claimed
 * atomically before the command runs and every write is guarded by a generation that `arm`,
 * `disarm` and the claim itself bump, so overlapping ticks run the command at most once, a
 * write from a tick that read before a claim cannot resurrect the countdown, and a user's
 * arm/disarm during the command is never clobbered.
 */
import { Cause, Effect, Exit, Option, Ref } from "effect";

import type { CliError } from "@corvi/contracts/errors";
import type { PowerAgent, PowerStateDto } from "@corvi/contracts/power";

import type { PowerShape } from "../../capabilities/power.ts";
import { isQuiet } from "../rule.ts";
import { advance, type PowerState } from "./state.ts";

/** The stored state plus a generation that `arm`/`disarm` bump. A tick captures the generation
 * when it reads; a write lands only while it is still current. */
type Store = {
  state: PowerState;
  generation: number;
};

const DISARMED: Store = { state: { phase: "disarmed" }, generation: 0 };

/** The sentence a failed power command carries: a typed error's message, or the rendered cause
 * for a defect (a thrown shell, a spawn failure). */
const failureMessage = (cause: Cause.Cause<CliError>): string => {
  const typed = Cause.findErrorOption(cause);
  return Option.isSome(typed) ? typed.value.message : Cause.pretty(cause);
};

export type MonitorOptions = {
  /** The fresh agent list, injected so a test can drive it. A failed read must never read as
   * quiet (see `tick`). */
  agents: () => Effect.Effect<readonly PowerAgent[], unknown>;
  /** The power service: a fake in tests, the live layer in the server. */
  power: PowerShape;
  /** The clock, injected so the tests never wait. */
  now: () => number;
  countdownMs: number;
  /** Fired after every persisted state change — arm, disarm, a countdown start or cancel, a
   * claim, a recorded failure — so the caller can announce it. */
  onChange?: () => void;
};

export type Monitor = {
  /** Arm, waiting for quiet; clears any previous failure. */
  arm: () => Effect.Effect<void>;
  /** Disarm from anywhere, clearing the countdown and any failure. */
  disarm: () => Effect.Effect<void>;
  /** The stored state plus a fresh agent list, exactly what the control renders. */
  state: () => Effect.Effect<PowerStateDto, unknown>;
  /** One decision. A no-op while disarmed. */
  tick: () => Effect.Effect<void>;
};

export const makeMonitor = ({
  agents,
  power,
  now,
  countdownMs,
  onChange,
}: MonitorOptions): Monitor => {
  const store = Effect.runSync(Ref.make<Store>(DISARMED));

  const notify = (): Effect.Effect<void> => Effect.sync(() => onChange?.());

  const sameState = (a: PowerState, b: PowerState): boolean =>
    a.phase === b.phase && a.deadline === b.deadline && a.error === b.error;

  /** Apply a state only while no arm/disarm has happened since the tick read it, and only when
   * it is actually different. Returns whether it wrote, so the caller announces only real changes. */
  const setIfCurrent = (generation: number, state: PowerState): Effect.Effect<boolean> =>
    Ref.modify(store, (current): readonly [boolean, Store] => {
      if (current.generation !== generation || sameState(current.state, state)) {
        return [false, current];
      }
      return [true, { state, generation: current.generation }];
    });

  /** Claim the fire: exactly one tick per countdown. Disarming makes a later tick a no-op, and
   * bumping the generation drops any write from a tick that read before this claim. Returns the
   * claimed generation, or undefined when another tick or a user's arm/disarm got there first. */
  const claim = (generation: number): Effect.Effect<number | undefined> =>
    Ref.modify(store, (current): readonly [number | undefined, Store] => {
      if (current.generation !== generation || current.state.phase !== "counting-down") {
        return [undefined, current];
      }
      const claimed = current.generation + 1;
      return [claimed, { state: { phase: "disarmed" }, generation: claimed }];
    });

  return {
    arm: () =>
      Ref.update(store, (current): Store => ({
        state: { phase: "armed" },
        generation: current.generation + 1,
      })).pipe(Effect.andThen(notify())),
    disarm: () =>
      Ref.update(store, (current): Store => ({
        state: { phase: "disarmed" },
        generation: current.generation + 1,
      })).pipe(Effect.andThen(notify())),
    state: () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(store);
        const list = yield* agents();
        return { ...current.state, agents: [...list] };
      }),
    tick: () =>
      Effect.gen(function* () {
        const before = yield* Ref.get(store);
        // Nothing to do while disarmed; in particular, do not read agents.
        if (before.state.phase === "disarmed") return;
        const read = yield* Effect.exit(agents());
        // A failed or defective read is not quiet: skip the tick and leave the state as it is.
        // This is the one case where a wrong answer would power a machine off, so it must never
        // mean "no agents".
        if (Exit.isFailure(read)) return;
        const decision = advance(before.state, isQuiet(read.value), now(), countdownMs);
        if (!decision.fire) {
          if (yield* setIfCurrent(before.generation, decision.state)) yield* notify();
          return;
        }
        // The countdown elapsed: claim before running the command so no second tick can fire.
        const claimed = yield* claim(before.generation);
        if (claimed === undefined) return;
        yield* notify();
        const outcome = yield* Effect.exit(power.powerOff());
        // A failure (typed or a defect) disarms with the sentence; a success is already disarmed
        // by the claim. Either way, do not clobber an arm/disarm issued during the command, and
        // write only under the claimed generation.
        if (Exit.isFailure(outcome)) {
          const wrote = yield* setIfCurrent(claimed, {
            phase: "disarmed",
            error: failureMessage(outcome.cause),
          });
          if (wrote) yield* notify();
        }
      }),
  };
};
