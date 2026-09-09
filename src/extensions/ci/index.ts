import { basename } from "node:path";
import { Effect } from "effect";
import type { Change, WidgetItem, WidgetState } from "../../types.ts";
import { createPrEffect, prItemEffect } from "../../integrations/github.ts";
import { checkItemsEffect } from "../../integrations/checks.ts";
import { pipelineItemsEffect } from "../../integrations/azure.ts";
import { BadRequestError, type CliError } from "../../effect/errors.ts";
import type { Extension } from "../api.ts";

/**
 * Pull requests and the pipelines they trigger, per repository: one question ("is this change
 * green?") answered in one card, rather than split across two vendors.
 */

/** repository > pull request > pipeline > runs, as one collapsible tree per repository. */
const repoItemEffect = (
  change: Change,
  repo: string,
): Effect.Effect<{ item: WidgetItem; prs: number; runs: number }> =>
  Effect.gen(function* () {
    const { number, item: pr } = yield* prItemEffect(change, repo);
    // Pipelines run on the PR merge ref once a PR exists, so the two are looked up together.
    const { items: azure, count } = yield* pipelineItemsEffect(change, repo, number);
    // Nothing found in Azure DevOps does not mean nothing ran: a repository can be built by
    // GitHub Actions, or by pipelines in another Azure project than the configured one. The pull
    // request itself knows about all of them, so fall back to what it reports.
    const pipelines =
      count === 0 && number ? yield* fallbackChecksEffect(change, repo, number, azure) : azure;
    const item: WidgetItem = {
      label: basename(repo),
      state: worst([pr, ...pipelines]),
      children: [{ ...pr, children: pipelines }],
    };
    return { item, prs: number ? 1 : 0, runs: count };
  });

const fallbackChecksEffect = (
  change: Change,
  repo: string,
  number: number,
  azure: WidgetItem[],
): Effect.Effect<WidgetItem[]> =>
  Effect.gen(function* () {
    const checks = yield* checkItemsEffect(change, repo, number);
    return checks.length ? checks : azure;
  });

const worst = (items: WidgetItem[]): WidgetState =>
  items.some((i) => i.state === "error")
    ? "error"
    : items.some((i) => i.state === "pending")
      ? "pending"
      : items.some((i) => i.state === "warn")
        ? "warn"
        : items.some((i) => i.state === "ok")
          ? "ok"
          : "none";

/** The CI card's action runner, in Effect. */
const runEffect = (
  change: Change,
  action: string,
  repo?: string,
): Effect.Effect<void, BadRequestError | CliError> =>
  Effect.gen(function* () {
    if (action !== "create") {
      return yield* Effect.fail(new BadRequestError({ message: `unknown ci action: ${action}` }));
    }
    if (!repo) return yield* Effect.fail(new BadRequestError({ message: "repo required" }));
    yield* createPrEffect(change, repo);
  });

export default {
  name: "ci",
  title: "CI",

  cards: [
    {
      title: "CI",
      wide: true,
      repoStatus: (change, repo) => Effect.map(repoItemEffect(change, repo), ({ item }) => [item]),
      run: (change, action, repo) => runEffect(change, action, repo),
    },
  ],
} satisfies Extension;
