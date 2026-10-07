/** The server's one power monitor, and the always-on fiber that ticks it.
 *
 * The local server owns its own arm state: this builds the monitor from the machine's own agents
 * and the live power command, exposes it to the routes, and starts the ticker. A tick while
 * disarmed is a no-op that never reads agents, so the fiber is cheap to leave running even when
 * nobody has armed anything.
 */
import { Effect, Schedule } from "effect";

import { env } from "@corvi/configuration/node";

import { announce } from "../../capabilities/bus.ts";
import { powerShape } from "../../capabilities/power.ts";
import { localAgents } from "./agents.ts";
import { makeMonitor } from "./monitor.ts";

const DEFAULT_COUNTDOWN_MS = 60_000;

/** The countdown, from `CORVI_POWER_COUNTDOWN_MS`: a finite, non-negative number, else the
 * default. Read once at startup. `0` is allowed and deliberate: it fires on the next quiet tick,
 * which is what a test uses to reach the power path without waiting. */
export const powerCountdownMs = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_COUNTDOWN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COUNTDOWN_MS;
};

const monitor = makeMonitor({
  agents: localAgents,
  power: powerShape,
  now: () => Date.now(),
  countdownMs: powerCountdownMs(process.env[env("POWER_COUNTDOWN_MS")]),
  // The one broadcast: a page hears `power` and refetches `GET /api/power`.
  onChange: () => announce("power"),
});

export const powerState = monitor.state;
export const armLocal = monitor.arm;
export const disarmLocal = monitor.disarm;

/** Fork the ticker: one decision a second, forever. A tick while disarmed does not read agents,
 * so this is the always-on fiber the plan calls for. A defect in one tick is swallowed so the
 * next still runs. */
export const startPowerMonitor = (): void => {
  Effect.runFork(
    monitor.tick().pipe(
      Effect.catchDefect(() => Effect.void),
      Effect.repeat(Schedule.spaced("1 second")),
    ),
  );
};
