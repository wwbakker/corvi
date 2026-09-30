/**
 * Agent state: publishes whether pi is working or waiting for you, why it is waiting, what the
 * session is called, and that it is pi — so anything outside the terminal can tell the
 * difference — Corvi's window strip and its notifications, a tmux status line, another program.
 *
 * The state is a tmux pane option, `@agent_status`; the agent's name is `@agent_name`; the
 * session's name is `@agent_session_name`; the first sentence of the last answer is
 * `@agent_last_message`. The vocabulary and the writer/reader rules are the reporter protocol in
 * docs/manual/terminals.md — this file is pi's reporter, `integrations/opencode` is opencode's.
 *
 *   tmux display -p '#{@agent_status}'          # this pane: working | waiting | unset
 *   tmux display -p '#{@agent_session_name}'    # this pane: the session's name, or empty
 *   tmux display -p '#{@agent_last_message}'    # this pane: why it wants you, or empty
 *   tmux list-windows -F '#{window_index} #{@agent_status}'  # every window of the session
 *
 * A pane option rather than the terminal title: the title is shared. pi rewrites it whenever
 * the session name changes — right after a run, when it names the session from your first
 * message — and the shell rewrites it between commands, so a title-based marker would vanish
 * seconds after it appeared. Nobody else writes `@agent_status`, and tmux drops
 * it when the pane dies, so a crashed agent leaves nothing stale behind.
 *
 * Install it with `bun run extension:install:pi` in the Corvi repository, which symlinks this
 * file into `~/.pi/agent/extensions/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The first sentence of the last assistant message, as one line: the notification says the
 * session's name and then this, so it has to be short and finite. A message that never ends a
 * sentence is cut and marked. */
export const firstSentence = (text: string, cap = 180): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const end = collapsed.search(/[.!?](?:\s|$)/);
  const sentence = end === -1 ? collapsed : collapsed.slice(0, end + 1);
  return sentence.length > cap ? `${sentence.slice(0, cap - 1).trimEnd()}…` : sentence;
};

/** The text of an assistant message, whatever else it carries (thinking, tool calls). Loosely
 * typed on purpose: this runs against pi's own message objects, and a change there should leave
 * the option empty rather than throw inside the agent loop. */
export const textOf = (message: unknown): string => {
  if (typeof message !== "object" || message === null) return "";
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "assistant" || !Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join(" ");
};

/** The full text of an assistant message, for the relay: parts joined with blank lines, so
 * paragraphs and code blocks survive. `textOf` is the notification's one-line version. */
export const fullTextOf = (message: unknown): string => {
  if (typeof message !== "object" || message === null) return "";
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "assistant" || !Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim();
};

export default function (pi: ExtensionAPI): void {
  // Where this reporter can publish: a Corvi host session (the CLI/HTTP channel, identity from
  // the pty environment) or a tmux pane (a subagent window, until it moves to a host session).
  // Outside both there is nothing to publish to, and every publish is a no-op.
  const sessionId = process.env.CORVI_SESSION_ID;
  const pane = process.env.TMUX_PANE;
  const inCorvi = sessionId !== undefined && sessionId !== "";

  let state: "working" | "waiting" = "waiting";
  /** The last answer's first sentence: what a notification says after the session's name — the
   * difference between "PROJ-1681 is waiting" and knowing why. */
  let lastSentence = "";

  /** Publish the whole status the agent has, through whichever channel is live. The CLI command
   * is fire-and-forget: a server or host that is gone must not disturb the agent loop. */
  const publish = (): void => {
    const sessionName = pi.getSessionName();
    if (inCorvi) {
      void pi
        .exec("corvi", [
          "status",
          state,
          "--name",
          "pi",
          ...(sessionName ? ["--session-name", sessionName] : []),
          ...(lastSentence ? ["--message", lastSentence] : []),
        ])
        .catch(() => {});
      return;
    }
    if (!pane) return;
    const set = (option: string, value: string | undefined): void => {
      const args = value ? ["set", "-p", "-t", pane, option, value] : ["set", "-p", "-t", pane, "-u", option];
      void pi.exec("tmux", args).catch(() => {});
    };
    set("@agent_status", state);
    set("@agent_name", "pi");
    set("@agent_session_name", sessionName || undefined);
    set("@agent_last_message", lastSentence || undefined);
  };

  pi.on("agent_start", async () => {
    state = "working";
    // The previous answer is no longer the news while a new one is being written.
    lastSentence = "";
    publish();
  });

  // Remember the answer here; publish it when the run settles. `agent_end` may still be followed
  // by a retry, a compaction, or queued messages.
  pi.on("agent_end", async (event) => {
    for (const message of [...event.messages].reverse()) {
      const text = textOf(message);
      if (text) {
        lastSentence = firstSentence(text);
        return;
      }
    }
  });

  // Settled rather than ended: after `agent_end` pi may still retry, auto-compact, or pick up
  // queued follow-up messages, and none of those are "waiting for you".
  pi.on("agent_settled", async () => {
    state = "waiting";
    publish();
  });

  // A session that has just started is waiting for its first prompt, and has said nothing yet.
  pi.on("session_start", async () => {
    state = "waiting";
    lastSentence = "";
    publish();
  });

  // Naming happens after the session starts — from your first message, or `/name` — and the
  // name is the thing worth showing, so it is published whenever it changes.
  pi.on("session_info_changed", async () => publish());

  // Leaving the pane to a plain shell: it is not waiting for you, it is not there at all.
  pi.on("session_shutdown", async () => {
    if (inCorvi) {
      void pi.exec("corvi", ["status", "clear"]).catch(() => {});
      return;
    }
    if (!pane) return;
    for (const option of ["@agent_status", "@agent_name", "@agent_session_name", "@agent_last_message"]) {
      void pi.exec("tmux", ["set", "-p", "-t", pane, "-u", option]).catch(() => {});
    }
  });
}
