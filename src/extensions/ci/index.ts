import { basename } from "node:path";
import { Effect } from "effect";
import { worst } from "../../core/domain/widget.ts";
import type { Change } from "../../core/domain/change.ts";
import type { WidgetItem, WidgetState } from "../../core/domain/widget.ts";
import { activeRuns, pipelineItems } from "../../integrations/azure.ts";
import { createPr, prItem, prSummary } from "../../integrations/github.ts";
import { checkItems } from "./checks.ts";
import { BadRequestError, type CliError } from "../../effect/errors.ts";
import type { Extension, SummaryContribution } from "../../core/host/api.ts";

/**
 * Pull requests and the pipelines they trigger, per repository: one question ("is this change
 * green?") answered in one card, rather than split across two vendors.
 */

/** repository > pull request > pipeline > runs, as one collapsible tree per repository. */
const repoItem = (
  change: Change,
  repo: string,
): Effect.Effect<{ item: WidgetItem; prs: number; runs: number }> =>
  Effect.gen(function* () {
    const { number, item: pr } = yield* prItem(change, repo);
    // Pipelines run on the PR merge ref once a PR exists, so the two are looked up together.
    const { items: azure, count } = yield* pipelineItems(change, repo, number);
    // Nothing found in Azure DevOps does not mean nothing ran: a repository can be built by
    // GitHub Actions, or by pipelines in another Azure project than the configured one. The pull
    // request itself knows about all of them, so fall back to what it reports.
    const pipelines =
      count === 0 && number ? yield* fallbackChecks(change, repo, number, azure) : azure;
    const item: WidgetItem = {
      label: basename(repo),
      state: worstItem([pr, ...pipelines]),
      children: [{ ...pr, children: pipelines }],
    };
    return { item, prs: number ? 1 : 0, runs: count };
  });

const fallbackChecks = (
  change: Change,
  repo: string,
  number: number,
  azure: WidgetItem[],
): Effect.Effect<WidgetItem[]> =>
  Effect.gen(function* () {
    const checks = yield* checkItems(change, repo, number);
    return checks.length ? checks : azure;
  });

/** The item-level variant of core/domain/widget.ts's `worst`: it reduces `WidgetItem[]` by their state, so a
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

/** The CI card's action runner. */
const runEffect = (
  change: Change,
  action: string,
  repo?: string,
): Effect.Effect<void, BadRequestError | CliError> =>
  Effect.gen(function* () {
    if (action !== "create") {
      return yield* new BadRequestError({ message: `unknown ci action: ${action}` });
    }
    if (!repo) return yield* new BadRequestError({ message: "repo required" });
    yield* createPr(change, repo);
  });

/**
 * The facts the change's overview card shows beyond its terminals: how many pipelines are in
 * flight and how many review comments wait, per repository in parallel. The pull request is
 * asked only for its open threads and its checks — the cached queries the dashboard already
 * makes — so the summary stays as cheap as the card it feeds. A repository's vendors being
 * down is the contributor's own failure, which the host swallows: the card loses the facts,
 * not the request.
 */
const summaryContribution = (
  change: Change,
): Effect.Effect<SummaryContribution, unknown> =>
  Effect.gen(function* () {
    const perRepo = yield* Effect.forEach(
      change.repos,
      (repo) =>
        Effect.gen(function* () {
          const { number, unresolved, checks } = yield* prSummary(change, repo);
          return { pipelines: yield* activeRuns(change, repo, number), unresolved, checks };
        }),
      { concurrency: "unbounded" },
    );
    const pipelines = perRepo.reduce((n, r) => n + r.pipelines, 0);
    const unresolved = perRepo.reduce((n, r) => n + r.unresolved, 0);
    return {
      facts: [
        {
          id: "pipelines",
          label:
            pipelines > 0
              ? `${pipelines} pipeline${pipelines === 1 ? "" : "s"} active`
              : "pipelines idle",
          state: pipelines > 0 ? "pending" : "none",
        },
        // Nothing at all when every thread is resolved: an empty inbox needs no line.
        ...(unresolved > 0
          ? [{
              id: "unresolved",
              label: `${unresolved} unresolved comment${unresolved === 1 ? "" : "s"}`,
              state: "warn" as const,
            }]
          : []),
      ],
      // A pipeline in flight is a build running, whatever the pull request's checks say about
      // the last one.
      state: worst([
        ...perRepo.map((r) => r.checks),
        ...(perRepo.some((r) => r.pipelines > 0) ? (["pending"] as WidgetState[]) : []),
      ]),
    };
  });

/**
 * What cancelling would leave open per repository: the pull request, when there is one, per
 * repository in parallel and in repository order. A repository with no pull request, or no
 * network, is not a loose end worth failing a cancellation over, so each lookup is best effort.
 */
const prLooseEnds = (change: Change): Effect.Effect<string[]> =>
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
  name: "ci",
  title: "CI",

  cards: [
    {
      title: "CI",
      wide: true,
      repoStatus: (change, repo) => Effect.map(repoItem(change, repo), ({ item }) => [item]),
      run: (change, action, repo) => runEffect(change, action, repo),
    },
  ],

  summaryContributions: [{ facts: summaryContribution }],

  // Cancelling leaves the pull requests open — closing somebody else's pull request is a
  // decision about theirs — and says so, one line per repository that has one.
  looseEnds: [{ looseEnds: prLooseEnds }],
} satisfies Extension;
