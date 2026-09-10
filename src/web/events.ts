import { useEffect } from "react";

/**
 * The page's end of `/api/events`: one connection for the whole tab.
 *
 * A hook per subscriber but a single `EventSource`, because the browser allows six connections
 * per origin and the terminal needs one of them. That limit is not theoretical here — it is why
 * the dashboard's widgets are unmounted rather than hidden when a terminal is on screen.
 *
 * `changes` and `windows` carry no data. They say that something changed; what changed is fetched
 * through the same routes as before, which are cached on the server. So a missed event costs one
 * refresh rather than a screen that disagrees with the disk. `notify` is the exception: it is
 * about a moment, not a state, and the moment would be gone by the time a fetch came back — so it
 * carries its own JSON.
 */

/** The events a page can hear. */
export type ServerEvent = "changes" | "windows" | "notify";

type Listener = (data: string) => void;

const listeners = new Map<string, Set<Listener>>();
let source: EventSource | undefined;

function emit(event: ServerEvent, data: string): void {
  for (const listener of listeners.get(event) ?? []) listener(data);
}

function connect(): EventSource {
  if (source) return source;
  const opened = new EventSource("/api/events");
  for (const event of ["changes", "windows", "notify"] as const) {
    opened.addEventListener(event, (e) => emit(event, (e as MessageEvent).data ?? ""));
  }
  // EventSource reconnects by itself, and what it missed while it was away is exactly what its
  // subscribers should now go and read. `notify` is deliberately not re-said: it is a moment,
  // and replaying it after a reconnect would announce something that has already happened.
  opened.addEventListener("open", () => {
    for (const [event, set] of listeners) {
      if (event === "notify") continue;
      for (const listener of set) listener("");
    }
  });
  source = opened;
  return opened;
}

/**
 * Run `onChange` whenever the server says this changed. The data is the event's payload, empty
 * for the events that carry none.
 *
 * `onChange` is expected to be stable — a `useCallback` — as it is for every caller here; an
 * identity that changes each render would resubscribe each render.
 */
export function useServerEvent(event: ServerEvent, onChange: Listener): void {
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
