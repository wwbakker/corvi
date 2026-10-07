/** The power API: read this machine's arm state, arm it, disarm it.
 *
 * The local server owns its own arm state; a remote server is reached through these same routes
 * by the fan-out. Every route sits behind `guard`, and the external listener's device-token
 * authorizer protects `/api/*`, so a remote server can be armed.
 */
import { Effect } from "effect";

import { InternalError } from "@corvi/contracts/errors";
import { PowerArmRequestSchema, type PowerTargetResultDto } from "@corvi/contracts/power";

import { runRoute } from "../capabilities/effect/run.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import { bodyAs, guard, json } from "../capabilities/web.ts";
import { armLocal, disarmLocal, powerState } from "./server/index.ts";

/** The machine's arm state, or a 500 carrying why it could not be verified. A failed agent read
 * is the answer itself: the control must show the machine un-armable rather than a state whose
 * empty agent list looks quiet. Typed failures and defects both become the same 500. */
const readState = (): Effect.Effect<Response, InternalError> =>
  powerState().pipe(
    Effect.map(json),
    Effect.catch((error) => Effect.fail(new InternalError({ message: messageOf(error) }))),
    Effect.catchDefect((defect) =>
      Effect.fail(new InternalError({ message: messageOf(defect) })),
    ),
  );

/** One result per target for the local server's own answer. A remote is not silently dropped:
 * the fan-out lands in a later change, so it answers `unsupported` with a reason. */
const resultsFor = (
  targets: readonly string[],
  local: "armed" | "disarmed",
): readonly PowerTargetResultDto[] =>
  targets.map((source) =>
    source === ""
      ? { source, status: local }
      : { source, status: "unsupported", detail: "remote fan-out is not available in this server yet" },
  );

export const powerRoutes = guard({
  // See `readState`.
  "/api/power": {
    GET: () => runRoute(readState()),
  },

  // Arm this machine when `""` is among the targets, and report every target on its own.
  "/api/power/arm": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = yield* bodyAs(req, PowerArmRequestSchema);
          if (body.targets.includes("")) yield* armLocal();
          return json({ results: resultsFor(body.targets, "armed") });
        }),
      ),
  },

  // Disarm this machine when `""` is among the targets; the same per-target shape as an arm.
  "/api/power/disarm": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = yield* bodyAs(req, PowerArmRequestSchema);
          if (body.targets.includes("")) yield* disarmLocal();
          return json({ results: resultsFor(body.targets, "disarmed") });
        }),
      ),
  },
});
