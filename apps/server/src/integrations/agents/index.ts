import type { IncludedIntegration } from "../types.ts";

/**
 * Coding agents: the status furniture of the windows they sit in — what they are called, which
 * glyph they draw, whether they are working. No cards, no wizard steps: it speaks only through
 * the presenter the agents package owns (`@corvi/agents/presenter`, composed into the window
 * pipeline by `apps/server/src/terminals/server/presenter.ts`), and loads first so its answers win over
 * anything a later extension says.
 */
export default {
  name: "agents",
  title: "Coding agents",
} satisfies IncludedIntegration;
