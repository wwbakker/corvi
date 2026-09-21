import { Effect } from "effect";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import { settingsView, writeSettings } from "./server/index.ts";
import { ConfigFile } from "../workspace/server/schema.ts";
import { bodyAs, json } from "../capabilities/web.ts";

export const settingsRoutes = guard({
  // The settings file, read and written from the page. Writing puts them into effect at once:
  // the config object every module holds is refilled rather than replaced.
  "/api/settings": {
    GET: () => runRoute(Effect.map(settingsView, json)),
    PUT: (req) =>
      runRoute(
        Effect.gen(function* () {
          return json(yield* writeSettings(yield* bodyAs(req, ConfigFile)));
        }),
      ),
  },
});
