import { Effect, Schema } from "effect";
import {
  BadRequestError,
  DecodeError,
  NotFoundError,
} from "@corvi/contracts/errors";
import { Changes } from "../api/capabilities.ts";
import type { IncludedIntegration } from "../types.ts";
import type { Change } from "@corvi/changes/record";
import { bodyAs } from "../../capabilities/effect/body.ts";
import { commitChange, fileDiff, localChanges, pushChange } from "./server.ts";
import type { CommitRequest } from "@corvi/contracts/integrations/review";
import { ShelveBodySchema } from "@corvi/contracts/shelves";
import { applyShelf, deleteShelf, listShelves, shelfPatch, shelveRepository } from "./shelves.ts";

/**
 * The review extension: the change's local-changes tab — what is uncommitted across the change,
 * the diff of one file, and the commit/push buttons.
 *
 * It contributes a change tab (rendered by its client half) and the routes that tab fetches
 * from, under its own namespace. The git logic lives beside it (./server.ts); this module only
 * describes it and finds the change each route is about through the contract's read-only
 * `Changes` store, exactly as the dispatcher's `/api/ext/review/...` namespace promises.
 */

/** The commit the page sends: one message, the files ticked in each repository. */
const CommitBody = Schema.Struct({
  message: Schema.String,
  files: Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String))),
});
const PushBody = Schema.Struct({
  repos: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
});
/** Which shelf an action is about: its id carries a `/`, so it travels in the body or query. */
const ShelfBody = Schema.Struct({ shelf: Schema.String });

const shelfParam = (req: Request): Effect.Effect<string, BadRequestError> => {
  const shelf = new URL(req.url).searchParams.get("shelf");
  return shelf ? Effect.succeed(shelf) : Effect.fail(new BadRequestError({ message: "shelf required" }));
};

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
            const body = yield* bodyAs(req, CommitBody);
            return Response.json(yield* commitChange(change, body));
          }),
        ),
    },
    {
      // The change's shelves: uncommitted work put aside, newest first.
      method: "GET",
      path: "/changes/:id/shelves",
      handler: (_req, params) =>
        withChange(params.id!, (change) => Effect.map(listShelves(change), (shelves) => Response.json(shelves))),
    },
    {
      // Put one repository's uncommitted work on a shelf. Every answer but `Shelved` left the
      // checkout exactly as it was — the too-large one names the biggest files and waits for
      // `allowLarge`.
      method: "POST",
      path: "/changes/:id/shelves",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            const body = yield* bodyAs(req, ShelveBodySchema);
            return Response.json(yield* shelveRepository(change, body));
          }),
        ),
    },
    {
      method: "POST",
      path: "/changes/:id/shelves/apply",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            const body = yield* bodyAs(req, ShelfBody);
            return Response.json(yield* applyShelf(change, body.shelf));
          }),
        ),
    },
    {
      method: "DELETE",
      path: "/changes/:id/shelves",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            yield* deleteShelf(change, yield* shelfParam(req));
            return Response.json({});
          }),
        ),
    },
    {
      // What a shelf holds, as the patch it is.
      method: "GET",
      path: "/changes/:id/shelves/patch",
      handler: (req, params) =>
        withChange(params.id!, (change) =>
          Effect.gen(function* () {
            return Response.json({ text: yield* shelfPatch(change, yield* shelfParam(req)) });
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
            const body = yield* bodyAs(req, PushBody);
            return Response.json(
              yield* pushChange(
                change,
                body.repos ?? (change.checkouts ?? []).map((spec) => spec.path),
              ),
            );
          }),
        ),
    },
  ],
} satisfies IncludedIntegration;
