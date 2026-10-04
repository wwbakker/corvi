import { Effect } from "effect";
import { runRoute } from "../capabilities/effect/run.ts";
import { guard } from "../capabilities/web.ts";
import { platformName } from "../capabilities/os.ts";
import { loaded } from "../integrations/index.ts";
import { PairRemoteWorkspaceRequestSchema } from "@corvi/contracts/api";
import {
  browse,
  pairRemoteWorkspace,
  remoteBranches,
  repositoriesDirectoryOf,
  resolveDirectory,
  workspaceById,
  workspaceViews,
} from "./server/index.ts";
import { attempt, bodyAs, json, withWorkspaceParam, workspaceParam } from "../capabilities/web.ts";

export const workspaceRoutes = guard({
  // The contexts you switch between: a client, your own projects. Configured, not discovered.
  // The response also carries the platform, once, at page bootstrap: the only place the UI
  // learns which key hints to draw. It is the server's platform — the shell the terminal
  // serves lives on this machine, so its conventions are the ones the page should hint at.
  "/api/workspaces": {
    // Masked: a remote workspace's device token and every declared extension secret are
    // redacted before the page sees them.
    GET: () => json({ workspaces: workspaceViews(loaded), platform: platformName }),
  },

  // Pair with a workspace hosted by another server: redeem the code there and answer with the
  // device and its raw token, which the settings editor stores in its draft. Run here because
  // the local server is the one whose config will hold the token, and because the page cannot
  // reach the remote itself (its origin would fail the remote's guard).
  "/api/workspaces/pair-remote": {
    POST: (req) =>
      runRoute(
        Effect.gen(function* () {
          const body = yield* bodyAs(req, PairRemoteWorkspaceRequestSchema);
          // The request's signal travels with the outbound call, so a client that hangs up
          // cancels the remote one. The answer carries a raw device token, so it is never cached.
          return json(yield* pairRemoteWorkspace({ ...body, signal: req.signal }), 201, {
            "cache-control": "no-store",
          });
        }),
      ),
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
