import { useEffect } from "react";

/**
 * The page's end of `/api/events`: one connection for the whole tab.
 *
 * A hook per subscriber but a single `EventSource`, because the browser allows six connections
 * per origin and the terminal needs one of them. That limit is not theoretical here — it is why
 * the dashboard's widgets are unmounted rather than hidden when a terminal is on screen.
 *
 * Events carry no data. They say that something changed; what changed is fetched through the same
 * routes as before, which are cached on the server. So a missed event costs one refresh rather
 * than a screen that disagrees with the disk.
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let source: EventSource | undefined;

function connect(): EventSource {
  if (source) return source;
  const opened = new EventSource("/api/events");
  for (const event of ["changes", "windows"]) {
    opened.addEventListener(event, () => {
      for (const listener of listeners.get(event) ?? []) listener();
    });
  }
  // EventSource reconnects by itself, and what it missed while it was away is exactly what its
  // subscribers should now go and read.
  opened.addEventListener("open", () => {
    for (const set of listeners.values()) for (const listener of set) listener();
  });
  source = opened;
  return opened;
}

/**
 * Run `onChange` whenever the server says this changed.
 *
 * `onChange` is expected to be stable — a `useCallback` — as it is for every caller here; an
 * identity that changes each render would resubscribe each render.
 */
export function useServerEvent(event: "changes" | "windows", onChange: Listener): void {
  useEffect(() => {
    connect();
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(onChange);
    listeners.set(event, set);
    return () => {
      set.delete(onChange);
    };
  }, [event, onChange]);
}
