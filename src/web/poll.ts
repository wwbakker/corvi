import { useEffect, useState } from "react";
import { moment } from "./moment.ts";

/**
 * How long a fetch has to take before a card admits to it. A local route answers in milliseconds,
 * and a mark that flickers on every tick reads as busier than the page is; the case worth showing
 * is the slow call — `az` starts a Python program per invocation, and a card makes several.
 */
const markDelay = 400;

/**
 * A card's own data, refetched on a timer, with the two facts its heading needs to say whether
 * what is on screen is current.
 *
 * `refreshing` is the heading's mark: only once a fetch has outlasted a blink, and never on the
 * first load, which says "loading…" for itself. `updated` is when the card last heard from the
 * server — the moment of the last attempt, successful or not, because a card that is failing to
 * refresh is exactly when you want to know how long it has been trying — ready for a tooltip.
 *
 * The loader reports its own failures: a card says what went wrong in its own words, and the hook
 * only times it. It must be stable across renders or the poll restarts, so wrap it in
 * `useCallback`.
 */
export function usePolled(
  load: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
): { refreshing: boolean; updated: string | undefined } {
  const [refreshing, setRefreshing] = useState(false);
  const [updated, setUpdated] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Cancel on unmount: these requests are slow, and the browser only allows six at a time, so
    // leaving them open makes the next page wait seconds for a free connection.
    const ac = new AbortController();
    let live = true;
    let inFlight = 0;
    let mark: ReturnType<typeof setTimeout> | undefined;
    // Whether this card has shown anything yet: the first fetch is the load, not a refresh.
    let settled = false;

    const run = (): void => {
      inFlight += 1;
      // One timer for the flight, however many runs it takes: the mark goes up once and comes
      // down when the last of them has answered.
      if (inFlight === 1 && settled) mark = setTimeout(() => setRefreshing(true), markDelay);
      void load(ac.signal)
        .catch(() => {}) // the card's own catch has already said what went wrong
        .finally(() => {
          inFlight -= 1;
          if (inFlight === 0) {
            clearTimeout(mark);
            mark = undefined;
            if (live) setRefreshing(false);
          }
          if (!live) return;
          settled = true;
          setUpdated(`updated ${moment(new Date().toISOString())}`);
        });
    };

    void run();
    const timer = setInterval(run, intervalMs);
    return () => {
      live = false;
      ac.abort();
      clearInterval(timer);
      clearTimeout(mark);
    };
  }, [load, intervalMs]);

  return { refreshing, updated };
}
