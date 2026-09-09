import { Effect } from "effect";
import type { Change, ChangeSummary, WidgetState } from "./types.ts";
import { activeRunsEffect } from "./integrations/azure.ts";
import { prSummaryEffect } from "./integrations/github.ts";
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
          const { number, unresolved, checks } = yield* prSummaryEffect(change, repo);
          return { pipelines: yield* activeRunsEffect(change, repo, number), unresolved, checks };
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

