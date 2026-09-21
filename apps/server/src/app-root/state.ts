import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type { WindowActionBodyDto } from "@corvi/contracts/api";
import { apiClient, type Change } from "./api.ts";
import { useServerEvent } from "./events.ts";
import type { TerminalWindow } from "../domain/terminal.ts";

/**
 * Every change's tmux windows, and the two things you do to them.
 *
 * One request for all of them, because the navigation column lists the terminals of every change
 * at once — and no poller at all: the server watches tmux and says when it changed. A poll would
 * only add requests for a thing that changes when you press a key in a terminal.
 */
export function useWindows(): {
  windows: Record<string, TerminalWindow[]>;
  select: (id: string, index: number) => void;
  create: (id: string) => Promise<void>;
  move: (id: string, from: number, to: number) => void;
  refresh: () => Promise<void>;
} {
  const [windows, setWindows] = useState<Record<string, TerminalWindow[]>>({});

  const load = useCallback(
    () =>
      apiClient
        .terminals()
        .then(setWindows)
        .catch(() => {}), // no tmux server yet: the next tick will find it
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useServerEvent("windows", load);

  const act = useCallback(
    (id: string, body: WindowActionBodyDto) =>
      apiClient
        .windowAction(ChangeId.make(id), body)
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
 * Where the change you are looking at opens its terminal socket.
 *
 * Asked for only when a terminal is actually opened: the URL is the server's, and asking on
 * arrival is a request for every change you so much as looked at, which is not what opening a
 * dashboard means. A change needs no terminal at all some days.
 */
export function useTerminal(
  id: string | null,
  archived: boolean,
  wanted: boolean,
): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
  }, [id]);

  useEffect(() => {
    if (!id || archived || !wanted) return;
    apiClient
      .terminalUrl(ChangeId.make(id))
      .then((r) => setUrl(r.url))
      .catch((e: Error) => setError(e.message));
  }, [id, archived, wanted]);

  return { url, error };
}

/** Every change: the navigation column lists the active ones and the overview lists them all.
 * One request for both, made again when the server says the change files moved. */
export function useChanges(): {
  changes: Change[] | undefined;
  setChanges: Dispatch<SetStateAction<Change[] | undefined>>;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [changes, setChanges] = useState<Change[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      apiClient
        .list()
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
