import { Effect } from "effect";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import { platformName } from "../capabilities/os.ts";
import { absolutePath, browse, config, remoteBranches } from "./server/index.ts";
import { attempt, json } from "../capabilities/web.ts";

export const workspaceRoutes = guard({
  // The contexts you switch between: a client, your own projects. Configured, not discovered.
  // The response also carries the platform, once, at page bootstrap: the only place the UI
  // learns which key hints to draw. It is the server's platform — the shell the terminal
  // serves lives on this machine, so its conventions are the ones the page should hint at.
  "/api/workspaces": {
    GET: () => json({ workspaces: config.workspaces, platform: platformName }),
  },

  // Directory browser rooted at the configured repos root; paths that escape it are rejected.
  "/api/repos": {
    GET: (req) =>
      runRoute(
        Effect.gen(function* () {
          // No path parameter at all: open where the configuration says. An explicit empty
          // one is the root, which is how "up" out of the starting directory works.
          return json(yield* browse(new URL(req.url).searchParams.get("path") ?? undefined));
        }),
      ),
  },

  // Branches a new worktree can start from, for the base selector.
  "/api/repos/branches": {
    GET: (req) =>
      runRoute(
        Effect.gen(function* () {
          const path = new URL(req.url).searchParams.get("path") ?? "";
          // Absolute paths come from the change itself; relative ones from the browser.
          const repo = yield* attempt(() => (path.startsWith("/") ? path : absolutePath(path)));
          return json(yield* remoteBranches(repo));
        }),
      ),
  },
});
