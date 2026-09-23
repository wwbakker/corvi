import type { WidgetStateDto } from "./api.ts";

/** Display vocabulary shared by the server and the browser: how a duration reads, and how
 * widget states compose. Pure — no runtime, no platform.
 */

/** How long ago, in the words the pages use: "just now", "12m ago", "3h ago", "2d ago".
 *
 * Shared rather than written twice: the Azure DevOps page bakes it into a line of its own ("2h
 * ago", "20260911.3 failed 2h ago") and a widget row shows it beside a build, and two answers to
 * one question drift. */
export const ago = (iso?: string | null): string => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/** One red build decides the colour; then one still running; then green. Pure, and here
 * rather than in a summary module because both halves need it and must not import the other's
 * server modules. */
export const worst = (states: WidgetStateDto[]): WidgetStateDto =>
  states.includes("error")
    ? "error"
    : states.includes("pending")
      ? "pending"
      : states.includes("warn")
        ? "warn"
        : states.includes("ok")
          ? "ok"
          : "none";

