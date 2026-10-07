/** The power API: read this machine's arm state, arm it, disarm it.
 *
 * The local server owns its own arm state; a remote server is reached through these same routes
 * by the fan-out. Every route sits behind `guard`, and the external listener's device-token
 * authorizer protects `/api/*`, so a remote server can be armed.
 */
import { Effect } from "effect";

import { InternalError, type IweError } from "@corvi/contracts/errors";
import { PowerArmRequestSchema, type PowerTargetResultDto } from "@corvi/contracts/power";

import { runRoute } from "../capabilities/effect/run.ts";
import { messageOf } from "../capabilities/effect/support.ts";
import { bodyAs, guard, json } from "../capabilities/web.ts";
import { fanOut, type PowerVerb } from "./server/fanout.ts";
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

/** Arm or disarm this machine and fan the command out to the remote targets, one result per
 * requested target in the order given. `""` is this machine; a non-empty source goes through
 * the fan-out, which reports a result even when it cannot reach the remote. */
const handle = (req: Request, verb: PowerVerb): Effect.Effect<Response, IweError> =>
  Effect.gen(function* () {
    const body = yield* bodyAs(req, PowerArmRequestSchema);
    const local = body.targets.includes("");
    // One request per distinct remote, however many times it is named.
    const remotes = [...new Set(body.targets.filter((source) => source !== ""))];
    if (local) yield* verb === "arm" ? armLocal() : disarmLocal();
    const remoteResults =
      remotes.length === 0 ? [] : yield* Effect.promise(() => fanOut(verb, remotes));
    const bySource = new Map(remoteResults.map((result) => [result.source, result]));
    const results = body.targets.map((source): PowerTargetResultDto =>
      source === ""
        ? { source, status: verb === "arm" ? "armed" : "disarmed" }
        : (bySource.get(source) ?? {
            source,
            status: "refused",
            detail: "the fan-out produced no result",
          }),
    );
    return json({ results });
  });

export const powerRoutes = guard({
  // See `readState`.
  "/api/power": {
    GET: () => runRoute(readState()),
  },

  "/api/power/arm": {
    POST: (req) => runRoute(handle(req, "arm")),
  },

  "/api/power/disarm": {
    POST: (req) => runRoute(handle(req, "disarm")),
  },
});
