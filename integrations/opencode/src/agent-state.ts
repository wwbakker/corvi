/**
 * Agent state: publishes whether opencode is working or waiting for you, why it is waiting, and
 * what the session is called, so anything outside the terminal can tell the difference — Corvi's
 * window strip and its notifications, a tmux status line, another program.
 *
 * The state is a tmux pane option, `@agent_status`; the agent's name is `@agent_name`; the
 * session's name is `@agent_session_name`; the first sentence of the last answer is
 * `@agent_last_message`. The vocabulary and the writer/reader rules are the reporter protocol in
 * docs/manual/terminals.md — this file is the opencode reporter, `integrations/pi` is pi's.
 *
 * A pane option rather than the terminal title: the title is shared and rewritten constantly, so
 * a title-based marker would vanish seconds after it appeared. Nobody else writes these options,
 * and tmux drops them when the pane dies, so a crashed agent leaves nothing stale behind.
 *
 * It is an opencode plugin in the current module form (`{ id, server }`), installed by
 * `bun run extension:install:opencode`, which symlinks this file into opencode's plugin directory
 * (`~/.config/opencode/plugin/`). opencode's core-v2 plugin surface (`{ id, setup }`) cannot be a
 * reporter: it has no event subscription.
 */

import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";

/** The events opencode sends its plugins, derived from the hook signature so this file needs no
 * second dependency on the SDK package. */
type HookEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];

/** The first sentence of the last assistant message, as one line: the notification says the
 * session's name and then this, so it has to be short and finite. A message that never ends a
 * sentence is cut and marked. Deliberately the same six lines as the pi reporter's: both files
 * are loaded by their agent outside Corvi's module graph and share nothing but the protocol. */
export const firstSentence = (text: string, cap = 180): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const end = collapsed.search(/[.!?](?:\s|$)/);
  const sentence = end === -1 ? collapsed : collapsed.slice(0, end + 1);
  return sentence.length > cap ? `${sentence.slice(0, cap - 1).trimEnd()}…` : sentence;
};

/** The one answer being written, as opencode writes it: text arrives as `message.part.updated`
 * events per part, a resent part replaces itself, and the answer is the parts joined in the order
 * they first appeared. Pure state, so the shape of an answer is testable without opencode. */
export type AnswerTracker = {
  /** A new answer begins for this message; parts of any earlier message are forgotten. */
  begin(messageID: string): void;
  /** One text part of the current answer, as it accumulates. Parts of other messages and parts
   * opencode marks ignored contribute nothing. */
  addPart(messageID: string, partID: string, body: string, ignored?: boolean): void;
  /** The answer so far. */
  answer(): string;
  /** Forget the answer entirely: a new prompt is in, and the old answer is no longer the news. */
  clear(): void;
};

export const trackAnswer = (): AnswerTracker => {
  let current: string | undefined;
  const parts = new Map<string, string>();
  return {
    begin: (messageID: string): void => {
      if (current === messageID) return;
      current = messageID;
      parts.clear();
    },
    addPart: (messageID: string, partID: string, body: string, ignored?: boolean): void => {
      if (current !== messageID || ignored) return;
      parts.set(partID, body);
    },
    answer: (): string => [...parts.values()].join(" "),
    clear: (): void => {
      current = undefined;
      parts.clear();
    },
  };
};

const reporter: PluginModule = {
  id: "corvi-agent-state",
  server: async (input: PluginInput): Promise<Hooks> => {
    // The pane this instance was started in, fixed for the life of the process: opencode runs one
    // server process per instance, and each sees its own `TMUX_PANE`. Unset outside tmux, where
    // there is nothing to publish to.
    const pane = process.env.TMUX_PANE;

    const publish = (option: string, value: string | undefined): void => {
      if (!pane) return;
      // Fire and forget: a failing tmux (no server, pane gone) must not disturb the session. The
      // shell escapes interpolations, so a session name with spaces is one argument.
      void (value
        ? input.$`tmux set -p -t ${pane} ${option} ${value}`
        : input.$`tmux set -p -t ${pane} -u ${option}`
      ).catch(() => {});
    };

    const publishState = (state: "working" | "waiting"): void => publish("@agent_status", state);

    /** The session's display name, once opencode has one: it is what the window should be called
     * outside, instead of the repository and the fact that opencode is in it. */
    const publishName = (title: string | undefined): void =>
      publish("@agent_session_name", title?.trim() || undefined);

    /** The last answer's first sentence: what a notification says after the session's name — the
     * difference between "PROJ-1681 is waiting" and knowing why. */
    const answer = trackAnswer();
    const publishSay = (): void => publish("@agent_last_message", firstSentence(answer.answer()) || undefined);

    // Subagent runs are real child sessions of their own and report their own busy/idle cycles
    // inside the parent's run; they are not this window waiting for you. Their session ids arrive
    // with `session.created`/`session.updated` carrying a `parentID`.
    const children = new Set<string>();
    const isChild = (sessionID: string): boolean => children.has(sessionID);

    // A session that has just started is waiting for its first prompt, and has said nothing yet —
    // the same opening state pi reports on `session_start`.
    publish("@agent_name", "opencode");
    publishState("waiting");
    publishSay();

    return {
      event: async ({ event }: { event: HookEvent }): Promise<void> => {
        try {
          switch (event.type) {
            case "message.updated": {
              const info = event.properties.info;
              if (isChild(info.sessionID)) return;
              if (info.role === "user") {
                // A new prompt: a run is on, and the previous answer is no longer the news.
                if (info.summary) return; // a generated summary, not a prompt
                answer.clear();
                publishSay();
                publishState("working");
              } else if (!info.summary) {
                answer.begin(info.id);
              }
              return;
            }
            case "message.part.updated": {
              const part = event.properties.part;
              if (part.type === "text") answer.addPart(part.messageID, part.id, part.text, part.ignored);
              return;
            }
            case "session.status": {
              const status = event.properties.status;
              if (isChild(event.properties.sessionID)) return;
              // busy, or retrying: a run is in flight or on its way back. A retry is not "waiting
              // for you" — pi's settled-vs-ended distinction says the same.
              publishState(status.type === "idle" ? "waiting" : "working");
              if (status.type === "idle") publishSay();
              return;
            }
            case "session.idle": {
              // The deprecated twin of `session.status` idle; both may arrive, and settling twice
              // changes nothing.
              if (isChild(event.properties.sessionID)) return;
              publishState("waiting");
              publishSay();
              return;
            }
            case "session.error": {
              // An error wants you — the attention is the same waiting state, and the last answer
              // is still what it said before failing.
              publishState("waiting");
              publishSay();
              return;
            }
            case "session.created":
            case "session.updated": {
              const info = event.properties.info;
              if (info.parentID) children.add(info.id);
              else {
                children.delete(info.id);
                // Naming happens as the conversation goes — opencode titles a session after the
                // first exchange — so the name is published whenever it changes.
                publishName(info.title);
              }
              return;
            }
            case "session.deleted": {
              children.delete(event.properties.info.id);
              return;
            }
          }
        } catch {
          // A shape this file did not expect: leave the options as they are rather than throw
          // inside the agent loop.
        }
      },
      dispose: async (): Promise<void> => {
        // Leaving the pane to a plain shell: it is not waiting for you, it is not there at all.
        for (const option of ["@agent_status", "@agent_name", "@agent_session_name", "@agent_last_message"]) {
          publish(option, undefined);
        }
      },
    };
  },
};

export default reporter;
