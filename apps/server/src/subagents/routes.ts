/** The Subagents page's routes: the profile files by scope, and writing one file at a time.
 *
 * The same shape as the Actions page's `/api/actions/files`: files are the source of truth, and
 * anything that is not a profile is refused with the reasons rather than saved anyway. */
import { Effect, Schema } from "effect";

import { SubagentFileRefSchema, SubagentFileWriteSchema } from "@corvi/contracts/subagents";
import { BadRequestError } from "@corvi/contracts/errors";
import { bodyAs, guard, json } from "../capabilities/web.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { deleteSubagentFile, subagentFiles, writeSubagentFile } from "./server/files.ts";

export const subagentsRoutes = guard({
  "/api/subagents/files": {
    GET: () => runRoute(Effect.map(subagentFiles(), json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeSubagentFile(yield* bodyAs(req, SubagentFileWriteSchema)));
        }),
      ),
    DELETE: (req) =>
      runRoute(
        Effect.gen(function* () {
          const params = Object.fromEntries(new URL(req.url).searchParams);
          const ref = yield* Schema.decodeUnknown(SubagentFileRefSchema)(params).pipe(
            Effect.mapError(() => new BadRequestError({ message: "scope and id are required" })),
          );
          return json(yield* deleteSubagentFile(ref));
        }),
      ),
  },
});
