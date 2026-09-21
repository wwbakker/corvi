/**
 * The widget vocabulary the dashboard and the integrations share. The shapes are the
 * contract's (`@corvi/contracts/api`), re-exported here under the names the app uses; `worst`
 * is the one piece of behavior that belongs with them.
 */
import type { WidgetStateDto as WidgetState } from "@corvi/contracts/api";

export type {
  SummaryFactDto as SummaryFact,
  WidgetDto as Widget,
  WidgetItemDto as WidgetItem,
  WidgetStateDto as WidgetState,
} from "@corvi/contracts/api";

/** One red build decides the colour; then one still running; then green. Pure, and here
 * rather than in dashboard/server/summary.ts because integration code needs it (the ci
 * integration's verdict) and must not import that summary through the host — that would be a
 * module cycle. */
export const worst = (states: WidgetState[]): WidgetState =>
  states.includes("error")
    ? "error"
    : states.includes("pending")
      ? "pending"
      : states.includes("warn")
        ? "warn"
        : states.includes("ok")
          ? "ok"
          : "none";
