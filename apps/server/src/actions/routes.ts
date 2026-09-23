/** The action menu's routes: what this change may run, and running one by key.
 *
 * Two routes, one rule the plan states twice on purpose: the client names an action and never
 * sends its text, so a prompt is pasted and a command runs exactly as the file on disk says,
 * whatever the page last showed. */
import { Effect, Schema } from "effect";

import {
  ActionFileRefSchema,
  ActionFileWriteSchema,
  RunActionRequestSchema,
} from "@corvi/contracts/actions";
import { BadRequestError } from "@corvi/contracts/errors";
import { bodyAs, guard, json, withChange } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { actionFiles, deleteActionFile, writeActionFile } from "./server/files.ts";
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

  // The Actions page's files: the list with each file's text and its problems, and writing one
  // file at a time. Files are the source of truth — saving an action writes its own file — and
  // anything that is not an action is refused with the reasons rather than saved anyway.
  "/api/actions/files": {
    GET: () => runRoute(Effect.map(actionFiles(), json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeActionFile(yield* bodyAs(req, ActionFileWriteSchema)));
        }),
      ),
    DELETE: (req) =>
      runRoute(
        Effect.gen(function* () {
          const params = Object.fromEntries(new URL(req.url).searchParams);
          const ref = yield* Schema.decodeUnknown(ActionFileRefSchema)(params).pipe(
            Effect.mapError(() => new BadRequestError({ message: "scope and id are required" })),
          );
          return json(yield* deleteActionFile(ref));
        }),
      ),
  },
});
