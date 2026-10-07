/** The arm/countdown state machine, pure: given the current state, whether the agents are quiet,
 * and the clock, it says what the state becomes and whether the power command is due.
 *
 * No IO and no clock of its own — the monitor supplies `now` and the countdown length — so every
 * transition is unit-testable without a timer.
 */
import type { PowerPhase } from "@corvi/contracts/power";

/** The stored arm state. `deadline` is present only while counting down; `error` is a failed
 * power-off, cleared by the next arm or by an explicit disarm. */
export type PowerState = {
  phase: PowerPhase;
  deadline?: string;
  error?: string;
};

/** What one decision produces: the next state, and whether the caller should run the power
 * command now. `fire` leaves the state as it is; the caller disarms once the command settles. */
export type Advance = {
  state: PowerState;
  fire: boolean;
};

/** The transitions:
 *
 * - disarmed never changes and never fires;
 * - armed waits: quiet starts the countdown, busy keeps it armed (and clears any deadline);
 * - counting-down cancels back to armed on a busy edge — the target stays armed — and fires once
 *   the deadline has passed while quiet.
 */
export const advance = (
  state: PowerState,
  quiet: boolean,
  now: number,
  countdownMs: number,
): Advance => {
  switch (state.phase) {
    case "disarmed":
      return { state, fire: false };
    case "armed":
      return quiet
        ? {
            state: {
              phase: "counting-down",
              deadline: new Date(now + countdownMs).toISOString(),
            },
            fire: false,
          }
        : { state: { phase: "armed" }, fire: false };
    case "counting-down": {
      if (!quiet) return { state: { phase: "armed" }, fire: false };
      // A missing deadline is a state that never started a countdown: do not fire on it.
      const deadline = state.deadline === undefined ? Number.NaN : Date.parse(state.deadline);
      return now >= deadline ? { state, fire: true } : { state, fire: false };
    }
  }
};
