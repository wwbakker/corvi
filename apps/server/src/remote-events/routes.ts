/** The availability owner's HTTP surface: the current map and one coordinated retry. */
import { Effect } from "effect";
import { runRoute } from "../capabilities/effect/run.ts";
import {
  runtimeRemoteAvailabilityRetry,
  runtimeRemoteAvailabilitySnapshot,
} from "../capabilities/runtime.ts";
import { guard, json } from "../capabilities/web.ts";

export const availabilityRoutes = guard({
  // The whole map. A page that has just connected or reconnected reads this rather than replaying
  // events, because the stream is a live invalidation, not durable history.
  "/api/remotes/availability": {
    GET: () => json(runtimeRemoteAvailabilitySnapshot()),
  },

  // Retry now: an immediate coordinated health check. A healthy stream is not interrupted; the
  // answer is the map as it stands when the request is handled. An unknown or local source is a
  // 404, not a silent success.
  "/api/remotes/:source/availability/retry": {
    POST: (req) =>
      runRoute(Effect.map(runtimeRemoteAvailabilityRetry(req.params.source), json)),
  },
});
