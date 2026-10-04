/** The Tailscale publication API: read the status, publish the external listener, stop
 * publishing it.
 *
 * These routes sit on both listeners and are guarded like every other route; on the external
 * listener the settings page's cookie authenticates them. They only ever touch this machine's own
 * serve mapping (`apps/server/src/tailscale/server/tailscale.ts`).
 */
import { Effect } from "effect";

import { guard, json } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { publishTailscale, tailscaleStatus, unpublishTailscale } from "./server/index.ts";

export const tailscaleRoutes = guard({
  "/api/tailscale": {
    GET: () => runRoute(Effect.map(tailscaleStatus(), json)),
  },

  // Publish `http://127.0.0.1:<remoteAccess.port>` at https 443. Refused with a message when 443
  // already serves something else, or the external listener is not listening.
  "/api/tailscale/publish": {
    POST: () => runRoute(Effect.map(publishTailscale(), json)),
  },

  // Remove only our own mapping; never `tailscale serve reset`.
  "/api/tailscale/unpublish": {
    POST: () => runRoute(Effect.map(unpublishTailscale(), json)),
  },
});
