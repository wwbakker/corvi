import { Effect } from "effect";
import { config } from "../workspace/server/index.ts";
import { runRoute } from "../effect/run.ts";
import { guard } from "../origin.ts";
import { platformName } from "../platform.ts";
import { settingsView, writeSettings, type Settings } from "../settings/server/index.ts";
import { bodyOf, json } from "./helpers.ts";

export const settingsRoutes = guard({
  // The contexts you switch between: a client, your own projects. Configured, not discovered.
  // The response also carries the platform, once, at page bootstrap: the only place the UI
  // learns which key hints to draw. It is the server's platform — the shell the terminal
  // serves lives on this machine, so its conventions are the ones the page should hint at.
  "/api/workspaces": {
    GET: () => json({ workspaces: config.workspaces, platform: platformName }),
  },

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
