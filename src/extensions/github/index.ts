import { basename } from "node:path";
import { Effect } from "effect";
import { worst } from "../../domain/widget.ts";
import type { Change } from "../../domain/change.ts";
import type { WidgetItem, WidgetState } from "../../domain/widget.ts";
import { Cache, Changes, Shell, Workspace } from "../../integrations/api/capabilities.ts";
import { prItem, prSummary, createPr } from "../../vendors/github.ts";
import { checkItems } from "./checks.ts";
import { BadRequestError, type CliError } from "../../capabilities/effect/errors.ts";
import type { IncludedIntegration } from "../../integrations/types.ts";
import type { SummaryContribution, SummaryContributor } from "../../integrations/overview.ts";

/**
 * Pull requests and the checks they report, per repository: whether this change is green, from
 * GitHub's side.
 *
 * The tree is `repository > pull request > checks`: the pull request row carries the review
 * state, and its children are the checks the pull request itself reports — GitHub Actions, Azure
 * Pipelines in any project, Cypress, whatever the repository has bolted on. Azure DevOps
 * pipelines in the configured project are the azure-devops extension's own rows on its own
 * card; the two cards read side by side rather than in one tree.
 */

/** repository > pull request > checks, as one collapsible tree per repository. */
const repoItem = (
  change: Change,
  repo: string,
): Effect.Effect<WidgetItem, BadRequestError, Changes | Shell | Workspace | Cache> =>
  Effect.gen(function* () {
    const { number, item: pr } = yield* prItem(change, repo);
    const checks = number ? yield* checkItems(change, repo, number) : [];
    const item: WidgetItem = {
      label: basename(repo),
      state: worstItem([pr, ...checks]),
      children: [{ ...pr, children: checks.length ? checks : undefined }],
    };
    return item;
  });

/** The item-level variant of domain/widget.ts's `worst`: it reduces `WidgetItem[]` by their state, so a
 * card can pick a verdict from its own rows as well as from a list of states. */
const worstItem = (items: WidgetItem[]): WidgetState =>
  items.some((i) => i.state === "error")
    ? "error"
    : items.some((i) => i.state === "pending")
      ? "pending"
      : items.some((i) => i.state === "warn")
        ? "warn"
        : items.some((i) => i.state === "ok")
          ? "ok"
          : "none";

/** The GitHub card's action runner. */
const runEffect = (
  change: Change,
  action: string,
  repo?: string,
): Effect.Effect<void, BadRequestError | CliError, Changes | Shell | Workspace | Cache> =>
  Effect.gen(function* () {
    if (action !== "create") {
      return yield* new BadRequestError({ message: `unknown github action: ${action}` });
    }
    if (!repo) return yield* new BadRequestError({ message: "repo required" });
    yield* createPr(change, repo);
  });

/**
 * The facts the change's overview card shows beyond its terminals: how many review comments
 * wait, per repository in parallel. The pull request is asked only for its open threads and its
 * checks — the cached queries the dashboard already makes — so the summary stays as cheap as
 * the card it feeds. A repository's vendor being down is the contributor's own failure, which
 * the host swallows: the card loses the facts, not the request.
 */
const summaryContribution = (
  change: Change,
): Effect.Effect<SummaryContribution, unknown, Changes | Shell | Workspace | Cache> =>
  Effect.gen(function* () {
    const perRepo = yield* Effect.forEach(
      change.repos,
      (repo) =>
        Effect.gen(function* () {
          const { unresolved, checks } = yield* prSummary(change, repo);
          return { unresolved, checks };
        }),
      { concurrency: "unbounded" },
    );
    const unresolved = perRepo.reduce((n, r) => n + r.unresolved, 0);
    return {
      facts: [
        // Nothing at all when every thread is resolved: an empty inbox needs no line.
        ...(unresolved > 0
          ? [{
              id: "unresolved",
              label: `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}`,
              state: "warn" as const,
            }]
          : []),
      ],
      state: worst(perRepo.map((r) => r.checks)),
    };
  });

/** The overview contributor: the open threads and the checks' verdict, as the card says them. */
export const githubSummaryContributor: SummaryContributor = { facts: summaryContribution };

/**
 * What cancelling would leave open per repository: the pull request, when there is one, per
 * repository in parallel and in repository order. A repository with no pull request, or no
 * network, is not a loose end worth failing a cancellation over, so each lookup is best effort.
 */
export const prLooseEnds = (
  change: Change,
): Effect.Effect<string[], never, Changes | Shell | Workspace | Cache> =>
  Effect.map(
    Effect.forEach(
      change.repos,
      (repo) =>
        Effect.map(
          Effect.orElseSucceed(prSummary(change, repo), () => undefined),
          (summary) => (summary?.number ? `${basename(repo)} #${summary.number} is still open` : undefined),
        ),
      { concurrency: "unbounded" },
    ),
    (prs) => prs.filter((p): p is string => Boolean(p)),
  );

export default {
  name: "github",
  title: "GitHub",

  cards: [
    {
      title: "GitHub",
      repoStatus: (change, repo) => Effect.map(repoItem(change, repo), (item) => [item]),
      run: (change, action, repo) => runEffect(change, action, repo),
    },
  ],
} satisfies IncludedIntegration;
