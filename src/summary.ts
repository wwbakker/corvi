import type { Change, ChangeSummary, WidgetState } from "./types.ts";

export type { ChangeSummary };
import { activeRuns } from "./integrations/azure.ts";
import { prSummary } from "./integrations/github.ts";
import { listWindows } from "./terminal.ts";
import { busyWindows } from "./windows.ts";

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
export async function summaryOf(change: Change): Promise<ChangeSummary> {
  const windows = await listWindows(change.id);
  const perRepo = await Promise.all(
    change.repos.map(async (repo) => {
      const { number, unresolved, checks } = await prSummary(change, repo);
      return { pipelines: await activeRuns(change, repo, number), unresolved, checks };
    }),
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
}
