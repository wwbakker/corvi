import { Effect } from "effect";
import { toResponse } from "./http.ts";

/**
 * How server.ts will run a route effect once the wiring task lands: the effect produces the
 * Response it wants on success, and anything it fails with — typed taxonomy error or a defect
 * that escaped — goes through http.ts's mapping (an escaped defect lands as the old fail()
 * would have treated it: 400 with its message). Nothing imports this yet; it is here so the
 * failure path of every future route has exactly one implementation.
 */
export const runRoute = (effect: Effect.Effect<Response, unknown>): Promise<Response> =>
  Effect.runPromise(Effect.catchAllDefect(effect, (defect) => Effect.fail(defect))).catch(
    toResponse,
  );
