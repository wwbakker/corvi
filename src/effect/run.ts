import { Effect } from "effect";
import { toResponse } from "./http.ts";

/**
 * How a route effect runs: the effect produces the Response it wants on success, and anything
 * it fails with — typed taxonomy error or a defect that escaped — goes through http.ts's mapping
 * (an escaped defect lands as 400 with its message). server.ts's route handlers run through
 * this, so the failure path of every route has exactly one implementation.
 *
 * Both channels are mapped inside the runtime, not on the returned Promise: `Effect.runPromise`
 * rejects with a `FiberFailure` wrapper, so a Promise-level catch sees the wrapper rather than
 * the taxonomy tag and every typed error would land as a 400.
 */
export const runRoute = (effect: Effect.Effect<Response, unknown>): Promise<Response> =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchAll((error) => Effect.succeed(toResponse(error))),
      Effect.catchAllDefect((defect) => Effect.succeed(toResponse(defect))),
    ),
  );
