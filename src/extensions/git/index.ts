import { Effect } from "effect";
import { gitRun, provisionRepo, repoItem } from "../../vendors/git.ts";
import type { Extension } from "../../extension-host/api.ts";

/**
 * Local changes: the worktree card, and the change:created provisioning.
 *
 * The implementation lives in src/vendors/git.ts, because half the core — completing,
 * cancelling, committing, browsing — shares its helpers. This extension describes the card
 * and the change:created hook; their effects require nothing beyond the capabilities, so the
 * host provides everything they need.
 */
export default {
  name: "git",
  title: "Local changes",

  cards: [
    {
      title: "Local changes",
      repoStatus: (change, repo) => Effect.map(repoItem(change, repo), (item) => [item]),
      run: (change, action, repo) => gitRun(change, action, repo),
    },
  ],

  events: {
    // A new change means a checkout per repository — worktree, or in place where the change
    // says so — sequential on purpose: the second repository is set up only once the first
    // one is there to be seen.
    "change:created": [
      (change) =>
        Effect.forEach(change.repos, (repo) => provisionRepo(change, repo), {
          concurrency: 1,
          discard: true,
        }),
    ],
  },
} satisfies Extension;
