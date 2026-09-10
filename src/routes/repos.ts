import { Effect } from "effect";
import { runRoute } from "../effect/run.ts";
import { listLeftovers, removeLeftover } from "../leftovers.ts";
import { guard } from "../origin.ts";
import { absolutePath, browse, remoteBranches } from "../repos.ts";
import { attempt, json } from "./helpers.ts";

export const reposRoutes = guard({
  // Directories left in the changes root by changes that are done: shown, never removed on
  // your behalf.
  "/api/leftovers": {
    GET: () => runRoute(Effect.map(listLeftovers, json)),
  },
  "/api/leftovers/:name": {
    DELETE: (req) =>
      runRoute(
        Effect.gen(function* () {
          yield* removeLeftover(req.params.name);
          return json(yield* listLeftovers);
        }),
      ),
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
