import { Effect } from "effect";
import { provisionOrBrowse, gitRun, provisionRepo, repoItem, unlinkRepo } from "../../vendors/git.ts";
import type { Extension } from "../../extension-host/api.ts";

/**
 * Local changes: the worktree card, and the change provisioning hooks.
 *
 * The implementation lives in src/vendors/git.ts, because half the core — completing,
 * cancelling, committing, browsing — shares its helpers. This extension describes the card and
 * the two provisioning hooks; their effects require nothing beyond the capabilities, so the
 * host provides everything they need.
 *
 * Creating an idea only links its repositories for browsing; starting the work is what creates
 * the checkouts, so an idea that never starts leaves no branch and no worktree behind.
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
    // one is there to be seen. An idea starts with only a browse link: nothing but reading.
    "change:created": [
      (change) =>
        Effect.forEach(
          change.repos,
          (repo) => provisionOrBrowse(change, repo),
          { concurrency: 1, discard: true },
        ),
    ],
    // Starting the work turns each browse link into the checkout the change asked for.
    "change:started": [
      (change) =>
        Effect.forEach(
          change.repos,
          (repo) =>
            Effect.gen(function* () {
              yield* unlinkRepo(change, repo);
              yield* provisionRepo(change, repo);
            }),
          { concurrency: 1, discard: true },
        ),
    ],
  },
} satisfies Extension;
