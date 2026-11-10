import { useCallback, useEffect, useRef, useState } from "react";
import { moment } from "./moment.ts";

/**
 * How long a fetch has to take before a card admits to it. A local route answers in milliseconds,
 * and a mark that flickers on every tick reads as busier than the page is; the case worth showing
 * is the slow call — `az` starts a Python program per invocation, and a card makes several.
 */
const markDelay = 400;

/** Why a fetch ran: on the timer, or because somebody asked for it. A manual run is the answer to
 * a click, so it says so at once instead of after the blink delay, and a page may read live for
 * it — `?refresh=1` — where a tick reads what the server has. */
export type PollReason = "poll" | "manual";

/**
 * A card's own data, refetched on a timer, with the two facts its heading needs to say whether
 * what is on screen is current.
 *
 * `refreshing` is the heading's mark: only once a fetch has outlasted a blink, and never on the
 * first load, which says "loading…" for itself — except for a manual refresh, whose mark is the
 * acknowledgement of the click. `updated` is when the card last heard from the server — the
 * moment of the last attempt, successful or not, because a card that is failing to refresh is
 * exactly when you want to know how long it has been trying — ready for a tooltip; `updatedAt`
 * is the same moment as epoch milliseconds, for a caller that wants to show a live age.
 *
 * `refresh` runs the loader again now, as a manual run: it does not restart the poll, so the
 * timer keeps its cadence, and a run started while one is in flight shares its bookkeeping —
 * `refreshing` stays up until the last of them answers.
 *
 * The loader reports its own failures: a card says what went wrong in its own words, and the hook
 * only times it. It must be stable across renders or the poll restarts, so wrap it in
 * `useCallback`.
 */
export function usePolled(
  load: (signal: AbortSignal, reason: PollReason) => Promise<unknown>,
  intervalMs: number,
): {
  refreshing: boolean;
  updated: string | undefined;
  updatedAt: number | undefined;
  refresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);
  const [updated, setUpdated] = useState<string | undefined>(undefined);
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);

  // The effect's own `run`, so a manual refresh joins the poll that is already going rather than
  // starting a second one over the top of it. A ref, not state: `refresh` has to keep the same
  // identity across renders or every consumer's handlers would change with it.
  const runRef = useRef<((reason: PollReason) => void) | undefined>(undefined);

  useEffect(() => {
    // Cancel on unmount: these requests are slow, and the browser only allows six at a time, so
    // leaving them open makes the next page wait seconds for a free connection.
    const ac = new AbortController();
    let live = true;
    let inFlight = 0;
    let mark: ReturnType<typeof setTimeout> | undefined;
    // Whether this card has shown anything yet: the first fetch is the load, not a refresh.
    let settled = false;

    const run = (reason: PollReason): void => {
      inFlight += 1;
      // One timer for the flight, however many runs it takes: the mark goes up once and comes
      // down when the last of them has answered. A manual run does not wait: the click is the
      // reason it is showing.
      if (reason === "manual") {
        clearTimeout(mark);
        mark = undefined;
        setRefreshing(true);
      } else if (inFlight === 1 && settled) {
        mark = setTimeout(() => setRefreshing(true), markDelay);
      }
      void load(ac.signal, reason)
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
          setUpdatedAt(Date.now());
        });
    };

    runRef.current = run;
    // The first run is deferred by a task, and only if this effect is still the live one: a
    // StrictMode mount runs the effect, cleans it up and runs it again, and an immediate first
    // run would be sent, aborted and paid for twice — the live read on every arrival included.
    const begin = setTimeout(() => {
      if (live) run("poll");
    }, 0);
    const timer = setInterval(() => run("poll"), intervalMs);
    return () => {
      live = false;
      if (runRef.current === run) runRef.current = undefined;
      ac.abort();
      clearTimeout(begin);
      clearInterval(timer);
      clearTimeout(mark);
    };
  }, [load, intervalMs]);

  const refresh = useCallback((): void => {
    runRef.current?.("manual");
  }, []);

  return { refreshing, updated, updatedAt, refresh };
}
