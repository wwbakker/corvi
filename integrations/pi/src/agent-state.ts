/**
 * Agent state: publishes whether the agent is working or waiting for you, why it is waiting, what
 * the session is called, and which harness it is — so anything outside the terminal can tell the
 * difference: Corvi's window strip and its notifications, another program.
 *
 * The one channel is the Corvi CLI (`corvi status`), which posts to the server; identity comes
 * from the pty environment the host seeds (`CORVI_SESSION_ID`/`CORVI_SESSION_INCARNATION`), so
 * any Corvi session — an interactive shell, an action run, a subagent — is reported. Outside a
 * Corvi session there is nothing to publish to, and every publish is a no-op. A program that
 * cannot run the CLI may instead write the same status as an OSC 1337 `corvi=` sequence, which
 * the host parses and the server treats as a fallback (docs/manual/terminals.md).
 *
 * Install it with `bun run extension:install:pi` in the Corvi repository, which symlinks this
 * file into `~/.pi/agent/extensions/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { logLine } from "./node/log.ts";

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
  // the pty environment). Outside one there is nothing to publish to, and every publish is a
  // no-op.
  const sessionId = process.env.CORVI_SESSION_ID;
  const inCorvi = sessionId !== undefined && sessionId !== "";

  /** A failed publish is logged, not swallowed: a reporter that cannot reach the server should
   * say so somewhere the agent's operator can see. */
  const logFailure = (error: unknown): void => {
    logLine(`status publish failed: ${error instanceof Error ? error.message : String(error)}`);
  };

  let state: "working" | "waiting" = "waiting";
  /** The last answer's first sentence: what a notification says after the session's name — the
   * difference between "PROJ-1681 is waiting" and knowing why. */
  let lastSentence = "";

  /** Publish the whole status the agent has. The CLI command is fire-and-forget: a server or
   * host that is gone must not disturb the agent loop. */
  const publish = (): void => {
    if (!inCorvi) return;
    const sessionName = pi.getSessionName();
    void pi
      .exec("corvi", [
        "status",
        state,
        "--name",
        "pi",
        ...(sessionName ? ["--session-name", sessionName] : []),
        ...(lastSentence ? ["--message", lastSentence] : []),
      ])
      .catch(logFailure);
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

  // Leaving the session: it is not waiting for you, it is not there at all.
  pi.on("session_shutdown", async () => {
    if (!inCorvi) return;
    void pi.exec("corvi", ["status", "clear"]).catch(logFailure);
  });
}
