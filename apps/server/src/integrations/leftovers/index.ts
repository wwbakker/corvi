import { Effect } from "effect";
import { listLeftovers, removeLeftover } from "./server.ts";
import type { IncludedIntegration } from "../types.ts";

/**
 * The leftovers extension: the directories in the changes root that no longer belong to a
 * change.
 *
 * It contributes a page (the sidebar's Leftovers entry, rendered by its client half) and the two
 * routes that page fetches from, under its own namespace. The implementation — the `du` walk,
 * the git-kind probe, the guarded removal — lives beside it (./server.ts); this module only
 * describes it. The implementation resolves the changes root through change-store helpers.
 */
export default {
  name: "leftovers",
  title: "Leftovers",

  // The page URL is the id: /leftovers.
  pages: [{ id: "leftovers", title: "Leftovers" }],

  routes: [
    {
      // The directories that are not changes; everything the page shows comes from here.
      method: "GET",
      path: "/list",
      handler: () => Effect.map(listLeftovers, Response.json),
    },
    {
      // Remove one, then answer with the list as it is now. The dispatcher's pattern needs a
      // non-empty segment after /list, which a leftover name always is.
      method: "DELETE",
      path: "/list/:name",
      handler: (_req, params) =>
        Effect.gen(function* () {
          yield* removeLeftover(params.name!);
          return Response.json(yield* listLeftovers);
        }),
    },
  ],
} satisfies IncludedIntegration;
