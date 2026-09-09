import { Effect } from "effect";
import { gitRunEffect, provisionRepoEffect, repoItemEffect } from "../../integrations/git.ts";
import type { Extension } from "../api.ts";

/**
 * Local changes: the worktree card, and the provisioning it has always carried.
 *
 * The implementation lives where it always has (src/integrations/git.ts), because half the
 * core — completing, cancelling, committing, browsing — shares its helpers. This extension
 * describes the card and the change:created hook; their effects require nothing beyond the
 * capabilities, so the host provides everything they need.
 */
export default {
  name: "git",
  title: "Local changes",

  cards: [
    {
      title: "Local changes",
      repoStatus: (change, repo) => Effect.map(repoItemEffect(change, repo), (item) => [item]),
      run: (change, action, repo) => gitRunEffect(change, action, repo),
    },
  ],

  events: {
    // A new change means a checkout per repository — worktree, or in place where the change
    // says so — sequential on purpose: the second repository is set up only once the first
    // one is there to be seen.
    "change:created": [
      (change) =>
        Effect.forEach(change.repos, (repo) => provisionRepoEffect(change, repo), {
          concurrency: 1,
          discard: true,
        }),
    ],
  },
} satisfies Extension;
