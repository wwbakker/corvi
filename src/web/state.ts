import { useCallback, useEffect, useState } from "react";
import { api, post, type Change } from "./api.ts";
import { useServerEvent } from "./events.ts";
import type { TerminalWindow } from "../terminalTypes.ts";

/**
 * Every change's tmux windows, and the two things you do to them.
 *
 * One request for all of them, because the navigation column lists the terminals of every change
 * at once — and no poller at all: the server watches tmux and says when it changed. This used to
 * be a request every 1.5 seconds from every open page, for a thing that changes when you press a
 * key in a terminal.
 */
export function useWindows() {
  const [windows, setWindows] = useState<Record<string, TerminalWindow[]>>({});

  const load = useCallback(
    () =>
      api<Record<string, TerminalWindow[]>>("/terminals")
        .then(setWindows)
        .catch(() => {}), // no tmux server yet: the next tick will find it
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useServerEvent("windows", load);

  const act = useCallback(
    (id: string, body: { action: "new" | "select" | "move"; index?: number; from?: number; to?: number }) =>
      post<TerminalWindow[]>(`/changes/${id}/terminal/windows`, body)
        .then((next) => setWindows((all) => ({ ...all, [id]: next })))
        .catch(() => {}),
    [],
  );

  return {
    windows,
    select: useCallback((id: string, index: number) => void act(id, { action: "select", index }), [act]),
    create: useCallback((id: string) => act(id, { action: "new" }), [act]),
    /** Where a dragged tab landed: the window at `from` takes `to`'s place. */
    move: useCallback(
      (id: string, from: number, to: number) => void act(id, { action: "move", from, to }),
      [act],
    ),
    refresh: load,
  };
}

/**
 * The ttyd instance of the change you are looking at.
 *
 * Asked for only when a terminal is actually opened: asking on arrival started a ttyd — and, as
 * soon as the page connected, a tmux session — for every change you so much as looked at, which
 * is not what opening a dashboard means. A change needs no terminal at all some days.
 */
export function useTerminal(id: string | null, archived: boolean, wanted: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A terminal on record can outlive its tmux session: the server says so when the URL is asked
  // for, and the page says that rather than showing a dead frame as if it were a slow one.
  const [gone, setGone] = useState(false);
  const [pid, setPid] = useState<number | undefined>(undefined);

  useEffect(() => {
    setUrl(null);
    setError(null);
    setGone(false);
    setPid(undefined);
  }, [id]);

  useEffect(() => {
    if (!id || archived || !wanted) return;
    api<{ url: string; gone?: boolean; pid?: number }>(`/changes/${id}/terminal`)
      .then((r) => {
        setUrl(r.url);
        setGone(r.gone ?? false);
        setPid(r.pid);
      })
      .catch((e: Error) => setError(e.message));
  }, [id, archived, wanted]);

  return { url, error, gone, pid };
}

/** Every change: the navigation column lists the active ones and the overview lists them all.
 * One request for both, made again when the server says the change files moved. */
export function useChanges() {
  const [changes, setChanges] = useState<Change[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api<Change[]>("/changes")
        .then(setChanges)
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);
  useServerEvent("changes", reload);

  return { changes, setChanges, error, reload };
}
