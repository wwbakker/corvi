import type { Extension, TerminalPresenter } from "../api.ts";

/**
 * What a coding agent in a tmux window is doing, as it says itself.
 *
 * A window running pi looks like any other `node` process, so nothing here can tell "thinking"
 * from "waiting for you to answer" — which is the one thing worth knowing about it. pi's
 * `busy-title` extension sets `@agent` on its pane (`tmux set -p @agent working`).
 *
 * A pane option rather than the pane title: the title is shared with pi's own session name and
 * with the shell, which rewrite it constantly, and the marker kept being overwritten seconds
 * after it was set. Nobody else writes `@agent`, and tmux drops it when the pane dies, so a
 * crashed agent leaves nothing stale behind.
 *
 * The vocabulary is this extension's own business: the core never parses `@agent`, it only
 * carries the pane options presenters declare.
 */
const AGENT_STATES = ["working", "waiting"] as const;
type AgentState = (typeof AGENT_STATES)[number];

const agentOf = (option: string | undefined): AgentState | undefined =>
  AGENT_STATES.find((state) => state === option);

/** The presenter: reads `@agent` from every window's active pane and answers for the windows
 * where an agent speaks. Everything it leaves undefined — the label, the detail — the core
 * composes from the tmux facts, exactly as it does for a plain shell. */
const presenter: TerminalPresenter = {
  paneOptions: ["@agent"],
  present: (window) => {
    const agent = agentOf(window.options["@agent"]);
    if (!agent) return undefined;
    return {
      // An agent is `node` as far as tmux is concerned, which says nothing; what it told us
      // about itself says everything.
      running: `pi ${agent}`,
      icon: "agent",
      state: agent === "working" ? "ok" : "idle",
      busy: agent === "working",
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
  windowPresenters: [presenter],
} satisfies Extension;
