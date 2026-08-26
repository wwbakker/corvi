import type { AgentState } from "./terminalTypes.ts";

/** Shells: a window sitting at a prompt is idle, whatever the shell is called. */
const SHELLS = ["zsh", "bash", "sh", "fish", "-zsh", "-bash", "tmux"];

/**
 * Windows running something other than a shell — a build, an editor, a server. tmux reports the
 * command of the active pane, which is the one you would be looking at.
 *
 * An agent that says what it is doing is believed over its process name: pi sitting at its
 * prompt is `node`, which would otherwise be counted as work for as long as you left it open.
 *
 * Pure, and free of node imports, because the page counts the same windows the server does and
 * the two must not drift apart.
 */
export const busyWindows = (windows: { command: string; agent?: AgentState }[]): number =>
  windows.filter((w) =>
    w.agent ? w.agent === "working" : Boolean(w.command) && !SHELLS.includes(w.command),
  ).length;
