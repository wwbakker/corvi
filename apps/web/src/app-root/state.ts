import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { apiClient, type Change } from "./api.ts";
import { changeKey, clientFor, sourceOf, useSources, type Source } from "./sources.ts";
import { useServerEvent } from "./events.ts";
import type { TerminalWindow } from "../domain/terminal.ts";
import { makeWindowsStore, type SourceWindows, type WindowsStore } from "./windowState.ts";

/** The flat map the navigation column, the tab strip and the change page read: every source's
 * windows keyed by `changeKey(source, id)`, because two servers can mint the same change id. */
const flattenWindows = (bySource: Readonly<Record<string, SourceWindows>>): Record<string, TerminalWindow[]> => {
  const windows: Record<string, TerminalWindow[]> = {};
  for (const [source, entry] of Object.entries(bySource)) {
    for (const [id, list] of Object.entries(entry.byChange)) windows[changeKey(source, id)] = [...list];
  }
  return windows;
};

/** The same key for a mutation failure, so a change's page can say what failed. */
const flattenErrors = (
  errors: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [source, byChange] of Object.entries(errors)) {
    for (const [id, message] of Object.entries(byChange)) flat[changeKey(source, id)] = message;
  }
  return flat;
};

/**
 * Every change's terminal windows, and the things you do to them.
 *
 * One request per source for all of them, because the navigation column lists the terminals of
 * every change at once — and no poller at all: each server watches its windows and says when they
 * change. The ordering rules live in `windowState.ts`; this is the React adapter around them.
 */
export function useWindows(): {
  windows: Record<string, TerminalWindow[]>;
  /** What a selection/creation/move failed with, by `changeKey`, until the next success. */
  errors: Record<string, string>;
  select: (source: string, id: string, index: number) => void;
  create: (source: string, id: string) => Promise<void>;
  move: (source: string, id: string, from: number, to: number) => void;
  /** Bring a window to the front by stable identity, for the subagent pane's explicit click. */
  focus: (source: string, id: string, windowId: string) => void;
  refresh: () => void;
} {
  const { sources } = useSources();
  const store = useRef<WindowsStore | null>(null);
  if (store.current === null) {
    store.current = makeWindowsStore({
      list: (sourceId: string): Promise<Readonly<Record<string, readonly TerminalWindow[]>>> =>
        clientFor(sourceId).terminals.list(),
      act: (sourceId: string, changeId: string, action) =>
        clientFor(sourceId).terminals.windowAction(ChangeId.make(changeId), action),
    });
  }
  const current = store.current;
  const state = useSyncExternalStore(current.subscribe, current.snapshot, current.snapshot);
  const sourceIds = useMemo(() => sources.map((source) => source.id), [sources]);
  useEffect(() => {
    current.setSources(sourceIds);
  }, [current, sourceIds]);
  // A remote event says which source changed, but refetching every source is simpler and still
  // one request each; the store coalesces the overlap. Stable callbacks: an inline arrow would
  // resubscribe every render.
  const reload = useCallback((): void => current.refresh(), [current]);
  useServerEvent("windows", reload);
  useServerEvent("source", reload);

  const windows = useMemo(() => flattenWindows(state.bySource), [state.bySource]);
  const errors = useMemo(() => flattenErrors(state.errors), [state.errors]);

  return {
    windows,
    errors,
    select: useCallback(
      (source: string, id: string, index: number) => void current.select(source, id, index),
      [current],
    ),
    create: useCallback((source: string, id: string) => current.create(source, id), [current]),
    /** Where a dragged tab landed: the window at `from` takes `to`'s place. */
    move: useCallback(
      (source: string, id: string, from: number, to: number) => void current.move(source, id, from, to),
      [current],
    ),
    focus: useCallback(
      (source: string, id: string, windowId: string) => void current.focus(source, id, windowId),
      [current],
    ),
    refresh: reload,
  };
}

/** A terminal URL answer tagged with the target it belongs to, so a late answer can be shown only
 * for the target it was asked for. */
type TerminalUrlResult = {
  readonly source: string;
  readonly id: string;
  readonly url: string | null;
  readonly error: string | null;
};

/**
 * Where the change you are looking at opens its terminal socket.
 *
 * Asked for only when a terminal is actually opened: the URL is the owning server's, and asking
 * on arrival is a request for every change you so much as looked at, which is not what opening a
 * dashboard means. A change needs no terminal at all some days.
 */
export function useTerminal(
  source: string,
  id: string | null,
  archived: boolean,
  wanted: boolean,
): { url: string | null; error: string | null } {
  const [result, setResult] = useState<TerminalUrlResult | null>(null);

  useEffect(() => {
    if (!id || archived || !wanted) {
      setResult(null);
      return;
    }
    // Generation guard: the effect's cleanup cancels the request and makes its answer inert, so a
    // late result for a source/change the page has left cannot replace the current one (and cannot
    // blank the current terminal). The tag is the render-time half of the same rule.
    const controller = new AbortController();
    let live = true;
    setResult(null);
    clientFor(source)
      .terminals.url(ChangeId.make(id), { signal: controller.signal })
      // The remote answers a path relative to its own origin; the page reaches it through the
      // owning source's gateway prefix, so the socket stays same-origin.
      .then((r) => {
        if (!live) return;
        setResult({
          source,
          id,
          url: source === "" ? r.url : `${sourceOf(source).baseUrl}${r.url}`,
          error: null,
        });
      })
      .catch((e: Error) => {
        // The cleanup sets `live` false before it aborts, so an aborted request is already inert;
        // a genuine failure is the only thing that reaches here with `live` still true.
        if (!live) return;
        setResult({ source, id, url: null, error: e.message });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [source, id, archived, wanted]);

  const current = result !== null && result.source === source && result.id === id ? result : null;
  return { url: current?.url ?? null, error: current?.error ?? null };
}

/** One source's changes, tagged with it. A remote source keeps only the changes of the workspace
 * its config named: a change that names none belongs to the remote's default workspace. */
const changesOf = async (source: Source): Promise<Change[]> => {
  const changes = await clientFor(source.id).changes.list();
  if (source.id === "") {
    return changes.map((change) => ({ ...change, source: "" }));
  }
  return changes
    .filter((change) => (change.workspace ?? "default") === (source.remoteWorkspace ?? "default"))
    .map((change) => ({ ...change, source: source.id, workspace: source.id }));
};

/** Every change, local and remote: the navigation column lists the active ones and the overview
 * lists them all. Made again when any server says its change files moved. */
export function useChanges(): {
  changes: Change[] | undefined;
  setChanges: Dispatch<SetStateAction<Change[] | undefined>>;
  error: string | null;
  reload: () => Promise<void>;
} {
  const { sources } = useSources();
  const [changes, setChanges] = useState<Change[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    // Settled per source: one unreachable remote returns nothing, and the local changes still do.
    const results = await Promise.allSettled(sources.map(changesOf));
    setChanges(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
    const firstFailure = results.find((result) => result.status === "rejected");
    setError(firstFailure?.status === "rejected" ? String(firstFailure.reason) : null);
  }, [sources]);

  useEffect(() => {
    void reload();
  }, [reload]);
  // A remote event names its source; refetching every source is the simple, never-stale choice
  // (the same one `useWindows` makes). Stable callbacks: an inline arrow resubscribes each
  // render.
  const reloadChanges = useCallback((): void => void reload(), [reload]);
  useServerEvent("changes", reloadChanges);
  useServerEvent("source", reloadChanges);

  return { changes, setChanges, error, reload };
}
