import { Effect } from "effect";
import type { Change, ChangeSummary, WidgetState } from "./types.ts";
import { activeRuns } from "./integrations/azure.ts";
import { prSummary } from "./integrations/github.ts";
import { listWindowsEffect } from "./terminal.ts";
import { busyWindows } from "./windows.ts";

export type { ChangeSummary };

/** One red build decides the colour; then one still running; then green. */
export const worst = (states: WidgetState[]): WidgetState =>
  states.includes("error")
    ? "error"
    : states.includes("pending")
      ? "pending"
      : states.includes("warn")
        ? "warn"
        : states.includes("ok")
          ? "ok"
          : "none";

// TODO-MIGRATE — integrations (github.ts, azure.ts) are another worker's task: their Promise
// facades wrapped in Effect.tryPromise until that lands, then swept by the server task.
const prSummaryOf = (
  change: Change,
  repo: string,
): Effect.Effect<{ number?: number; unresolved: number; checks: WidgetState }, unknown> =>
  Effect.tryPromise({ try: () => prSummary(change, repo), catch: (e) => e });

// TODO-MIGRATE — same as above: integrations facade behind Effect.tryPromise until swept.
const activeRunsOf = (change: Change, repo: string, pr?: number): Effect.Effect<number, unknown> =>
  Effect.tryPromise({ try: () => activeRuns(change, repo, pr), catch: (e) => e });

/**
 * The overview's per-change numbers, gathered per repository in parallel.
 *
 * Deliberately cheap: it reuses the cached Azure DevOps queries the dashboard already makes and
 * asks the pull request only for its open threads, rather than building the widgets. A change
 * that answers slowly delays its own card and nothing else, because the browser asks for one
 * summary per card.
 */
export const summaryOfEffect = (change: Change): Effect.Effect<ChangeSummary, unknown> =>
  Effect.gen(function* () {
    const windows = yield* listWindowsEffect(change.id);
    const perRepo = yield* Effect.forEach(
      change.repos,
      (repo) =>
        Effect.gen(function* () {
          const { number, unresolved, checks } = yield* prSummaryOf(change, repo);
          return { pipelines: yield* activeRunsOf(change, repo, number), unresolved, checks };
        }),
      { concurrency: "unbounded" },
    );
    return {
      pipelines: perRepo.reduce((n, r) => n + r.pipelines, 0),
      unresolved: perRepo.reduce((n, r) => n + r.unresolved, 0),
      terminals: busyWindows(windows),
      windows: windows.length,
      // A pipeline in flight is a build running, whatever the pull request's checks say about the
      // last one.
      ci: worst([
        ...perRepo.map((r) => r.checks),
        ...(perRepo.some((r) => r.pipelines > 0) ? (["pending"] as WidgetState[]) : []),
      ]),
    };
  });

/** TODO-MIGRATE */
export const summaryOf = (change: Change): Promise<ChangeSummary> =>
  Effect.runPromise(summaryOfEffect(change));
