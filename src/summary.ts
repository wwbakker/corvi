import type { Change } from "./types.ts";
import { activeRuns } from "./integrations/azure.ts";
import { prSummary } from "./integrations/github.ts";
import { listWindows, type TerminalWindow } from "./terminal.ts";

/** What a change's card on the overview says beyond the change itself: the three things that
 * change while you are not looking at it. */
export type ChangeSummary = {
  /** Pipeline runs in flight across every repository of the change. */
  pipelines: number;
  /** tmux windows running something other than a shell: a build, an editor, a server. */
  terminals: number;
  /** Windows in the change's tmux session, so "idle" can be told from "no terminal". */
  windows: number;
  /** Open review threads across every pull request of the change. */
  unresolved: number;
};

/** Shells: a window sitting at a prompt is idle, whatever the shell is called. */
const SHELLS = ["zsh", "bash", "sh", "fish", "-zsh", "-bash", "tmux"];

/**
 * Windows running something other than a shell — a build, an editor, a server. tmux reports the
 * command of the active pane, which is the one you would be looking at.
 *
 * An agent that says what it is doing is believed over its process name: pi sitting at its
 * prompt is `node`, which would otherwise be counted as work for as long as you left it open.
 */
export const busyWindows = (windows: Pick<TerminalWindow, "command" | "agent">[]): number =>
  windows.filter((w) =>
    w.agent ? w.agent === "working" : Boolean(w.command) && !SHELLS.includes(w.command),
  ).length;

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
      const { number, unresolved } = await prSummary(change, repo);
      return { pipelines: await activeRuns(change, repo, number), unresolved };
    }),
  );
  return {
    pipelines: perRepo.reduce((n, r) => n + r.pipelines, 0),
    unresolved: perRepo.reduce((n, r) => n + r.unresolved, 0),
    terminals: busyWindows(windows),
    windows: windows.length,
  };
}
