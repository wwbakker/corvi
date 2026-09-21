import { Effect } from "effect";
import {
  BadRequestError,
  Changes,
  DecodeError,
  NotFoundError,
  type IncludedIntegration,
} from "../../integrations/types.ts";
import type { Change } from "../../domain/change.ts";
import { commitChange, fileDiff, localChanges, pushChange } from "./server.ts";
import type { CommitRequest } from "./shared.ts";

/**
 * The review extension: the change's local-changes tab — what is uncommitted across the change,
 * the diff of one file, and the commit/push buttons.
 *
 * It contributes a change tab (rendered by its client half) and the routes that tab fetches
 * from, under its own namespace. The git logic lives beside it (./server.ts); this module only
 * describes it and finds the change each route is about through the contract's read-only
 * `Changes` store, exactly as the dispatcher's `/api/ext/review/...` namespace promises.
 */

/** The request body. A body that will not parse is the caller's mistake, said as the core's
 * routes say it: a BadRequestError, which the status-code mapping turns into a 400. */
const bodyOf = (req: Request): Effect.Effect<unknown, BadRequestError> =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: (e) => new BadRequestError({ message: e instanceof Error ? e.message : String(e) }),
  });

/** Find the change a route is about through the `Changes` capability, or answer 404: the
 * extension never reaches the change store itself. */
const withChange = <E, R>(
  id: string,
  effect: (change: Change) => Effect.Effect<Response, E, R>,
): Effect.Effect<Response, E | NotFoundError | DecodeError, R | Changes> =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    const change = yield* changes.read(id);
    if (!change) return yield* new NotFoundError({ message: `no such change: ${id}` });
    return yield* effect(change);
  });

export default {
  name: "review",
  title: "Review changes",

  // The change's local-changes tab: uncommitted work across every repository, and the diff of
  // the selected file.
  changeTabs: [{ id: "review", title: "Review changes" }],

  routes: [
    {
      // What is uncommitted in one repository, and the diff of one file of it. Live: this is the
      // work you are doing, and a cached answer would be a wrong one.
      method: "GET",
      path: "/changes/:id/local",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            const repo = new URL(req.url).searchParams.get("path");
            if (!repo) {
              return yield* new BadRequestError({ message: "path required" });
            }
            return Response.json(yield* localChanges(change, repo));
          }),
        ),
    },
    {
      method: "GET",
      path: "/changes/:id/local/diff",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            const search = new URL(req.url).searchParams;
            const repo = search.get("path");
            const file = search.get("file");
            if (!repo || !file) {
              return yield* new BadRequestError({ message: "path and file required" });
            }
            return Response.json({
              text: yield* fileDiff(change, repo, file, search.get("staged") === "1"),
            });
          }),
        ),
    },
    {
      // One commit per repository, with the same message: a change is one piece of work.
      method: "POST",
      path: "/changes/:id/commit",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            return Response.json(yield* commitChange(change, (yield* bodyOf(req)) as CommitRequest));
          }),
        ),
    },
    {
      // Pushing what is committed, in the repositories that have something to push.
      method: "POST",
      path: "/changes/:id/push",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            const body = (yield* bodyOf(req)) as { repos?: string[] };
            return Response.json(yield* pushChange(change, body.repos ?? change.repos));
          }),
        ),
    },
  ],
} satisfies IncludedIntegration;
