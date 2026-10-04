import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type { WindowActionBodyDto } from "@corvi/contracts/api";
import { apiClient, type Change } from "./api.ts";
import { changeKey, clientFor, sourceOf, useSources, type Source } from "./sources.ts";
import { useServerEvent } from "./events.ts";
import type { TerminalWindow } from "../domain/terminal.ts";

/**
 * Every change's terminal windows, and the two things you do to them.
 *
 * One request per source for all of them, because the navigation column lists the terminals of
 * every change at once — and no poller at all: each server watches its windows and says when they
 * change. Windows are keyed by `changeKey(source, id)`, because two servers can mint the same
 * change id.
 */
export function useWindows(): {
  windows: Record<string, TerminalWindow[]>;
  select: (source: string, id: string, index: number) => void;
  create: (source: string, id: string) => Promise<void>;
  move: (source: string, id: string, from: number, to: number) => void;
  refresh: () => Promise<void>;
} {
  const { sources } = useSources();
  const [windows, setWindows] = useState<Record<string, TerminalWindow[]>>({});

  const load = useCallback(async (): Promise<void> => {
    // Settled per source: one unreachable remote must not stop the local windows from loading.
    const results = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        byChange: await clientFor(source.id).terminals.list(),
      })),
    );
    const merged: Record<string, TerminalWindow[]> = {};
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const [id, list] of Object.entries(result.value.byChange)) {
        merged[changeKey(result.value.source.id, id)] = list;
      }
    }
    setWindows(merged);
  }, [sources]);

  useEffect(() => {
    void load().catch(() => {}); // no host yet: the next tick will find it
  }, [load]);
  // A remote event says which source changed, but refetching every source is simpler and still
  // one request each; the result is a screen that is never stale, which matters more here than
  // the few wasted reads. Stable callbacks: an inline arrow would resubscribe every render.
  const reloadWindows = useCallback((): void => {
    void load().catch(() => {});
  }, [load]);
  useServerEvent("windows", reloadWindows);
  useServerEvent("source", reloadWindows);

  const act = useCallback(
    (source: string, id: string, body: WindowActionBodyDto) =>
      clientFor(source)
        .terminals.windowAction(ChangeId.make(id), body)
        .then((next) => setWindows((all) => ({ ...all, [changeKey(source, id)]: next })))
        .catch(() => {}),
    [],
  );

  return {
    windows,
    select: useCallback(
      (source: string, id: string, index: number) => void act(source, id, { action: "select", index }),
      [act],
    ),
    create: useCallback((source: string, id: string) => act(source, id, { action: "new" }), [act]),
    /** Where a dragged tab landed: the window at `from` takes `to`'s place. */
    move: useCallback(
      (source: string, id: string, from: number, to: number) =>
        void act(source, id, { action: "move", from, to }),
      [act],
    ),
    refresh: load,
  };
}

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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
  }, [source, id]);

  useEffect(() => {
    if (!id || archived || !wanted) return;
    clientFor(source)
      .terminals.url(ChangeId.make(id))
      // The remote answers a path relative to its own origin; the page reaches it through the
      // owning source's gateway prefix, so the socket stays same-origin.
      .then((r) => setUrl(source === "" ? r.url : `${sourceOf(source).baseUrl}${r.url}`))
      .catch((e: Error) => setError(e.message));
  }, [source, id, archived, wanted]);

  return { url, error };
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
