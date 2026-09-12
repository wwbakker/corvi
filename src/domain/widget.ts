export type WidgetState = "ok" | "pending" | "warn" | "none" | "error";

/** One red build decides the colour; then one still running; then green. Pure, and here
 * rather than in dashboard/server/summary.ts because extension code needs it (the ci
 * extension's verdict) and must not import that summary through the host — that would be a
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

/** One fact on a change's overview card: a coloured dot and a phrase. Lives here rather than
 * in the extension API because the summary surface (src/domain/change.ts's ChangeSummary,
 * and dashboard/server/summary.ts) speaks it too, and the contract already shares this
 * vocabulary. */
export type SummaryFact = {
  /** Stable key, e.g. "pipelines". */
  id: string;
  /** Rendered as-is: "2 pipelines active", "terminals idle". */
  label: string;
  /** Colours the dot; "none" is the idle grey. */
  state?: WidgetState;
};

/** One item inside a widget, e.g. a repo, a PR, a build. */
export type WidgetItem = {
  label: string;
  detail?: string;
  /** Colours the detail text, for things that ask for attention rather than describe. */
  detailTone?: WidgetState;
  url?: string;
  state?: WidgetState;
  /** Actions applicable to this item; `arg` is passed back to the integration. `confirm` asks
   * the question before running, for anything that could surprise. */
  actions?: { id: string; label: string; arg?: string; confirm?: string }[];
  /** Actions that belong to the row but not on it: shown behind a ⋯ button, for things you do
   * occasionally (open this repository somewhere) rather than act on. */
  menu?: { id: string; label: string; arg?: string; confirm?: string }[];
  /** Something still running: the browser ticks the elapsed time and draws a bar against the
   * expected duration, so a 15s poll does not make the clock stutter. */
  progress?: { startedAt: string; expectedMs?: number };
  /** When the thing this row is about happened: when a build finished, when an issue was last
   * touched. Something still running counts its age in `progress` instead — elapsed time and
   * "the moment it started" are one fact, and the bar is already showing it. The row shows how
   * long ago, with the exact moment on hover. */
  at?: string;
  /** Nested rows, rendered as a collapsible tree: repo > pull request > pipeline > runs. */
  children?: WidgetItem[];
};

/** What one extension reports about one change: the dashboard renders this as a card. The
 * `integration` field is the extension's name — the identity the browser knows the card by. */
export type Widget = {
  integration: string;
  title: string;
  state: WidgetState;
  summary: string;
  items: WidgetItem[];
};
