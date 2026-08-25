/**
 * Agent state: publishes whether pi is working or waiting for you, so anything outside the
 * terminal can tell the difference — IWE's window strip, a tmux status line, another program.
 *
 * The state is a tmux pane option, `@agent`:
 *
 *   tmux display -p '#{@agent}'                       # this pane: working | waiting | unset
 *   tmux list-windows -F '#{window_index} #{@agent}'  # every window of the session
 *
 * A pane option rather than the terminal title, which was the first attempt: the title is
 * shared. pi rewrites it whenever the session name changes — right after a run, when it names
 * the session from your first message — and the shell rewrites it between commands, so the
 * marker kept vanishing seconds after it appeared. Nobody else writes `@agent`, and tmux drops
 * it when the pane dies, so a crashed agent leaves nothing stale behind.
 *
 * Install it with `bun run extension:install` in the IWE repository, which symlinks this file
 * into `~/.pi/agent/extensions/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // The pane pi was started in, fixed for the life of the process: tmux moves panes around, but
  // the id follows the pane, and this process never moves to another one. Unset outside tmux,
  // where there is nothing to publish to.
  const pane = process.env.TMUX_PANE;

  const publish = (state: "working" | "waiting"): void => {
    if (!pane) return;
    // Fire and forget: a failing tmux (no server, pane gone) must not disturb the session.
    void pi.exec("tmux", ["set", "-p", "-t", pane, "@agent", state]).catch(() => {});
  };

  pi.on("agent_start", async () => publish("working"));

  // Settled rather than ended: after `agent_end` pi may still retry, auto-compact, or pick up
  // queued follow-up messages, and none of those are "waiting for you".
  pi.on("agent_settled", async () => publish("waiting"));

  // A session that has just started is waiting for its first prompt.
  pi.on("session_start", async () => publish("waiting"));

  // Leaving the pane to a plain shell: it is not waiting for you, it is not there at all.
  pi.on("session_shutdown", async () => {
    if (pane) void pi.exec("tmux", ["set", "-p", "-t", pane, "-u", "@agent"]).catch(() => {});
  });
}
