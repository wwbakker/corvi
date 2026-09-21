import { Effect } from "effect";
import { gitRun, repoItem } from "../../vendors/git.ts";
import type { IncludedIntegration } from "../../integrations/types.ts";

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
} satisfies IncludedIntegration;
