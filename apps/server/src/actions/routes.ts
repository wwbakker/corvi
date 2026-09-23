/** The action menu's routes: what this change may run, and running one by key.
 *
 * Two routes, one rule the plan states twice on purpose: the client names an action and never
 * sends its text, so a prompt is pasted and a command runs exactly as the file on disk says,
 * whatever the page last showed. */
import { Effect } from "effect";

import { RunActionRequestSchema } from "@corvi/contracts/actions";
import { bodyAs, guard, json, withChange } from "../capabilities/web.ts";
import { listActionsFor, runActionFor } from "./server/run.ts";

export const actionsRoutes = guard({
  "/api/changes/:id/terminal/actions": {
    GET: (req) => withChange(req.params.id, (c) => Effect.map(listActionsFor(c), json)),
    POST: (req) =>
      withChange(req.params.id, (c) =>
        Effect.gen(function* () {
          const body = yield* bodyAs(req, RunActionRequestSchema);
          return json(yield* runActionFor(c, body.key, body.window));
        }),
      ),
  },
});
