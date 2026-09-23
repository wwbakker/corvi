import type { TerminalPresenter } from "@corvi/contracts/terminal";

/**
 * What a coding agent in a tmux window is doing, as it says itself.
 *
 * A window running pi or opencode looks like any other `node` process, so nothing here can tell
 * "thinking" from "waiting for you to answer" — which is the one thing worth knowing about it.
 * The agent's reporter sets `@agent_status` on its pane (`tmux set -p @agent_status working`):
 * pi's extension (`integrations/pi`), opencode's plugin (`integrations/opencode`), or any other
 * writer of the protocol.
 *
 * A pane option rather than the pane title: the title is shared with the agent's own session name
 * and with the shell, which rewrite it constantly, so a marker there would not survive. Nobody
 * else writes these options, and tmux drops them when the pane dies, so a crashed agent leaves
 * nothing stale behind.
 *
 * The agent's name is published beside it as `@agent_name` and the session's name as
 * `@agent_session_name` (pi names the session from your first message, opencode titles it after
 * the first exchange); when the session name is there it is the label, because "example-api -
 * (opencode working)" says less about what is in the window than the name the session was given
 * does. The state stays in the icon's colour.
 *
 * The vocabulary is the reporter protocol stated in docs/manual/terminals.md: the core never
 * parses `@agent_status`, it only carries the pane options presenters declare.
 */
const AGENT_STATES = ["working", "waiting"] as const;
type AgentState = (typeof AGENT_STATES)[number];

const agentOf = (option: string | undefined): AgentState | undefined =>
  AGENT_STATES.find((state) => state === option);

/** The presenter: reads `@agent_status` from every window's active pane and answers for the windows
 * where an agent speaks. Everything it leaves undefined — the label, the detail — the core
 * composes from the tmux facts, exactly as it does for a plain shell. */
export const agentsWindowPresenter: TerminalPresenter = {
  paneOptions: ["@agent_status", "@agent_name", "@agent_session_name", "@agent_last_message"],
  present: (window) => {
    const agent = agentOf(window.options["@agent_status"]);
    if (!agent) return undefined;
    // Who is speaking: "pi", "opencode". A reporter that predates `@agent_name` still reads.
    const who = window.options["@agent_name"]?.trim() || "agent";
    const name = window.options["@agent_session_name"]?.trim();
    const note = window.options["@agent_last_message"]?.trim();
    return {
      // The session's own name, when the agent has given it one; otherwise the core composes the
      // label from the repository, exactly as it does for a plain shell.
      label: name || undefined,
      // An agent is `node` as far as tmux is concerned, which says nothing; what it told us
      // about itself says everything.
      running: `${who} ${agent}`,
      icon: "agent",
      state: agent === "working" ? "ok" : "idle",
      busy: agent === "working",
      // Waiting for you is what a notification is for; working is not. The edge into this is
      // the one thing the core looks at.
      attention: agent === "waiting",
      // What it just answered, in its own words.
      note: note || undefined,
    };
  },
};
