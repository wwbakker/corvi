import type { IncludedIntegration, TerminalPresenter } from "../../integrations/types.ts";

/**
 * What a coding agent in a tmux window is doing, as it says itself.
 *
 * A window running pi looks like any other `node` process, so nothing here can tell "thinking"
 * from "waiting for you to answer" — which is the one thing worth knowing about it. pi's
 * `busy-title` extension sets `@agent_status` on its pane (`tmux set -p @agent_status working`).
 *
 * A pane option rather than the pane title: the title is shared with pi's own session name and
 * with the shell, which rewrite it constantly, so a marker there would not survive. Nobody else
 * writes `@agent_status`, and tmux drops it when the pane dies, so a crashed agent leaves
 * nothing stale behind.
 *
 * The session's name is published beside it as `@agent_session_name` by the same extension (pi names
 * the session from your first message); when it is there it is the label, because "example-api -
 * (pi working)" says less about what is in the window than the name pi gave it does. The state
 * stays in the icon's colour.
 *
 * The vocabulary is this extension's own business: the core never parses `@agent_status`, it only
 * carries the pane options presenters declare.
 */
const AGENT_STATES = ["working", "waiting"] as const;
type AgentState = (typeof AGENT_STATES)[number];

const agentOf = (option: string | undefined): AgentState | undefined =>
  AGENT_STATES.find((state) => state === option);

/** The presenter: reads `@agent_status` from every window's active pane and answers for the windows
 * where an agent speaks. Everything it leaves undefined — the label, the detail — the core
 * composes from the tmux facts, exactly as it does for a plain shell. */
export const agentsWindowPresenter: TerminalPresenter = {
  paneOptions: ["@agent_status", "@agent_session_name", "@agent_last_message"],
  present: (window) => {
    const agent = agentOf(window.options["@agent_status"]);
    if (!agent) return undefined;
    const name = window.options["@agent_session_name"]?.trim();
    const note = window.options["@agent_last_message"]?.trim();
    return {
      // The session's own name, when pi has given it one; otherwise the core composes the
      // label from the repository, exactly as it does for a plain shell.
      label: name || undefined,
      // An agent is `node` as far as tmux is concerned, which says nothing; what it told us
      // about itself says everything.
      running: `pi ${agent}`,
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

/**
 * Coding agents: the status furniture of the windows they sit in — what they are called, which
 * glyph they draw, whether they are working. No cards, no wizard steps: it speaks only through
 * its presenter, and loads first so its answers win over anything a later extension says.
 */
export default {
  name: "agents",
  title: "Coding agents",
} satisfies IncludedIntegration;
