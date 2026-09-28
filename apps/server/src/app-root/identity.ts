/**
 * What this server knows, for a client that has to choose between several.
 *
 * The CLI discovers candidate servers (an explicit URL, the app's state files, the dev default)
 * and asks each one the same question before trusting it. Change ids are the answer because the
 * CLI's job is to route a named change to the server that owns it: a server whose list does not
 * contain the change is the wrong one, even if it is alive.
 */
import { Effect } from "effect";

import { listChanges } from "../change/server/index.ts";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard, json } from "../capabilities/web.ts";

export const identityRoutes = guard({
  "/api/identity": {
    GET: () =>
      runRoute(
        Effect.map(listChanges(), (changes) => json({ changeIds: changes.map((change) => change.id) })),
      ),
  },
});
