import { Effect } from "effect";
import { repoItem } from "../../vendors/git.ts";
import { gitRun } from "../../change/provisioning.ts";
import type { IncludedIntegration } from "../types.ts";

/**
 * Local changes: the worktree card, and the change provisioning hooks.
 *
 * The implementation lives in apps/server/src/vendors/git.ts, because half the core — completing,
 * cancelling, committing, browsing — shares its helpers. This extension describes the card and
 * its actions; their effects require nothing beyond the capabilities, so the host provides
 * everything they need.
 *
 * Creating an idea cuts its checkouts straight away: the worktree and the change's branch are
 * there while it is still an idea. What an idea never does is move a ticket — that waits for the
 * start.
 */
export default {
  name: "git",
  title: "Local changes",

  cards: [
    {
      title: "Local changes",
      // The repository editor is its client half's `edit`; the card only says it has one.
      editable: true,
      repoStatus: (change, repo) => Effect.map(repoItem(change, repo), (item) => [item]),
      run: (change, action, repo) => gitRun(change, action, repo),
    },
  ],
} satisfies IncludedIntegration;
