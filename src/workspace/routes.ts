import { Effect } from "effect";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import { platformName } from "../capabilities/os.ts";
import {
  browse,
  config,
  remoteBranches,
  repositoriesDirectoryOf,
  resolveDirectory,
  workspaceById,
} from "./server/index.ts";
import { attempt, json, withWorkspaceParam, workspaceParam } from "../capabilities/web.ts";

export const workspaceRoutes = guard({
  // The contexts you switch between: a client, your own projects. Configured, not discovered.
  // The response also carries the platform, once, at page bootstrap: the only place the UI
  // learns which key hints to draw. It is the server's platform — the shell the terminal
  // serves lives on this machine, so its conventions are the ones the page should hint at.
  "/api/workspaces": {
    GET: () => json({ workspaces: config.workspaces, platform: platformName }),
  },

  // Directory browser, unbounded: any absolute directory can be listed. No path parameter at
  // all opens the repositories directory the request's context resolves to; an explicit path
  // is where the page already is, or where a picker should open. Dot-directories are withheld
  // unless `hidden=1` asks for them.
  "/api/repos": {
    GET: (req) =>
      withWorkspaceParam(
        req,
        Effect.gen(function* () {
          const params = new URL(req.url).searchParams;
          const asked = params.get("path");
          const dir = yield* attempt(() =>
            asked === null
              ? repositoriesDirectoryOf(workspaceById(workspaceParam(req)))
              : resolveDirectory(asked),
          );
          return json(yield* browse(dir, params.get("hidden") === "1"));
        }),
      ),
  },

  // Branches a new worktree can start from, for the base selector. The path is always absolute
  // now: the change stores absolute paths, and so does the browser.
  "/api/repos/branches": {
    GET: (req) =>
      runRoute(
        Effect.gen(function* () {
          const path = new URL(req.url).searchParams.get("path") ?? "";
          const repo = yield* attempt(() => resolveDirectory(path));
          return json(yield* remoteBranches(repo));
        }),
      ),
  },
});
