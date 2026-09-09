import { Effect } from "effect";
import { createWorktreeEffect, gitRunEffect, repoItemEffect } from "../../integrations/git.ts";
import type { IweExtensionApi } from "../api.ts";

/**
 * Local changes: the worktree card, and the provisioning it has always carried.
 *
 * The implementation lives where it always has (src/integrations/git.ts), because half the
 * core — completing, cancelling, committing, browsing — shares its helpers. This extension
 * contributes the card and the change:created hook; their effects require nothing beyond the
 * capabilities, so the host provides everything they need.
 */
export default function (api: IweExtensionApi) {
  api.registerCard({
    title: "Local changes",

    repoStatus: (change, repo) =>
      Effect.map(repoItemEffect(change, repo), (item) => [item]),

    run: (change, action, repo) => gitRunEffect(change, action, repo),
  });

  // A new change means a worktree per repository, sequential on purpose: the second
  // repository is set up only once the first one is there to be seen.
  api.on("change:created", (change) =>
    Effect.forEach(change.repos, (repo) => createWorktreeEffect(change, repo), {
      concurrency: 1,
      discard: true,
    }));
}
