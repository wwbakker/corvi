import type { ChangeState } from "./api.ts";

/** One class per state, so the colour lives in the stylesheet: amber while it is yours to do,
 * blue while it waits on someone else, green when it is done. */
export const stateClass = (state?: ChangeState | string): string =>
  `state-${(state ?? "Implementation").toLowerCase().replace(/\s+/g, "-")}`;
