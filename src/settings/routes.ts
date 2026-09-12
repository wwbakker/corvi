import { Effect } from "effect";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import { settingsView, writeSettings, type Settings } from "./server/index.ts";
import { bodyOf, json } from "../capabilities/web.ts";

export const settingsRoutes = guard({
  // The settings file, read and written from the page. Writing puts them into effect at once:
  // the config object every module holds is refilled rather than replaced.
  "/api/settings": {
    GET: () => runRoute(Effect.map(settingsView, json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeSettings((yield* bodyOf(req)) as Settings));
        }),
      ),
  },
});
