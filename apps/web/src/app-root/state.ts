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
import type { CorviClient } from "@corvi/client";
import type { RemoteAvailabilityReasonDto, RemoteAvailabilityStatusDto } from "@corvi/contracts/availability";
import { apiClient, type Change } from "./api.ts";
import {
  changeKey,
  sourceOf,
  useAvailability,
  useSourceAvailability,
  useSourceOwner,
  useSources,
  type Source,
} from "./sources.ts";
import { gateFailureOf, statusOf, type OwnerAvailability } from "./sourceOwner.ts";
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
  const owner = useSourceOwner();
  const availability = useAvailability();
  // Keyed by owner: a new owner (StrictMode remount, HMR) must not leave the store calling a
  // disposed one's gate, which would refuse every remote read as "checking".
  const current = useMemo(
    () =>
      makeWindowsStore({
        // The generation captured when the work was queued is what the capability is bound to: an
        // owner retarget refuses an old queued action as stale instead of it acquiring the new
        // target's client (which would not wait for this page's reconfigure effect).
        list: (sourceId: string, generation: string): Promise<Readonly<Record<string, readonly TerminalWindow[]>>> =>
          owner.clientForGeneration(sourceId, generation).terminals.list(),
        act: (sourceId: string, generation: string, changeId: string, action) =>
          owner
            .clientForGeneration(sourceId, generation)
            .terminals.windowAction(ChangeId.make(changeId), action),
      }),
    [owner],
  );
  const state = useSyncExternalStore(current.subscribe, current.snapshot, current.snapshot);
  const sourceIds = useMemo(() => sources.map((source) => source.id), [sources]);
  useEffect(() => {
    current.setSources(sourceIds);
  }, [current, sourceIds]);
  // Target identity and reachability: a same-id retarget drops the old target's data, in-flight
  // reads and queued writes; a loss of reachability keeps the last known windows marked stale;
  // recovery re-reads. Local is always sendable.
  useEffect(() => {
    for (const source of sources) {
      const entry = availability.entries[source.id];
      current.reconfigure(
        source.id,
        source.id === "" ? "" : (entry?.generation ?? ""),
        source.id === "" || entry?.status._tag === "available",
      );
    }
  }, [availability, sources, current]);
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
): { url: string | null; error: string | null; unavailable: RemoteAvailabilityReasonDto | null } {
  const owner = useSourceOwner();
  const { status, generation } = useSourceAvailability(source);
  const unavailable = status._tag === "unavailable" ? status.reason : null;
  // A checking or unavailable workspace is not asked for a socket URL: there is nothing to
  // attach to, and the pane says why instead of reconnecting.
  const blocked = status._tag !== "available";
  const [result, setResult] = useState<TerminalUrlResult | null>(null);

  useEffect(() => {
    if (!id || archived || !wanted || blocked) {
      setResult(null);
      return;
    }
    // Generation guard: the effect's cleanup cancels the request and makes its answer inert, so a
    // late result for a source/change the page has left cannot replace the current one (and cannot
    // blank the current terminal). The tag is the render-time half of the same rule.
    const controller = new AbortController();
    let live = true;
    setResult(null);
    owner
      .clientFor(source)
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
  }, [source, id, archived, wanted, blocked, generation, owner]);

  const current = result !== null && result.source === source && result.id === id ? result : null;
  return { url: current?.url ?? null, error: current?.error ?? null, unavailable };
}

/** One source's changes, tagged with it. A remote source keeps only the changes of the workspace
 * its config named: a change that names none belongs to the remote's default workspace. */
const changesOf = async (client: CorviClient, source: Source): Promise<Change[]> => {
  const changes = await client.changes.list();
  if (source.id === "") {
    return changes.map((change) => ({ ...change, source: "" }));
  }
  return changes
    .filter((change) => (change.workspace ?? "default") === (source.remoteWorkspace ?? "default"))
    .map((change) => ({ ...change, source: source.id, workspace: source.id }));
};

/** One source's published list and whether it is the answer the last successful read gave. */
type SourceChanges = { readonly changes: Change[]; readonly stale: boolean; readonly generation: string };

/** What a read asked for: the target its answer belongs to. A late answer may only be published
 * for the same source, the same generation and the same reachability — a retarget or an outage
 * while it was in flight makes it another target's answer, and stamping it with the generation
 * read after the await would present old-target data as the new target's. */
export type ChangeReadTarget = {
  readonly source: string;
  readonly generation: string;
  readonly status: RemoteAvailabilityStatusDto["_tag"];
};

const statusTagOf = (
  entries: OwnerAvailability["entries"],
  source: string,
): RemoteAvailabilityStatusDto["_tag"] =>
  source === "" ? "available" : (entries[source]?.status._tag ?? "checking");

/** Whether the target a read captured is still the target the world has now. */
export const changeReadStillCurrent = (
  target: ChangeReadTarget,
  sourceIds: readonly string[],
  entries: OwnerAvailability["entries"],
): boolean =>
  sourceIds.includes(target.source) &&
  (entries[target.source]?.generation ?? "") === target.generation &&
  statusTagOf(entries, target.source) === target.status;

/** Every change, local and remote: the navigation column lists the active ones and the overview
 * lists them all. Published per source: an unavailable remote keeps its last known list marked
 * stale rather than emptying the page, and a removed source is pruned so a late answer cannot
 * republish it. Recovery reads only the source that recovered. */
export function useChanges(): {
  changes: Change[] | undefined;
  error: string | null;
  /** Sources whose list is the last known answer, not a current one. */
  staleSources: string[];
  reload: () => Promise<void>;
} {
  const { sources } = useSources();
  const owner = useSourceOwner();
  const availability = useAvailability();
  const [bySource, setBySource] = useState<Record<string, SourceChanges>>({});
  const [error, setError] = useState<string | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const availabilityRef = useRef(availability);
  availabilityRef.current = availability;
  const reads = useRef(new Map<string, number>());

  const readSource = useCallback(
    async (source: Source): Promise<void> => {
      // Only `available` remotes (and always the local server) are asked; a checking or
      // unavailable source keeps its last known list.
      if (source.id !== "" && statusOf(availabilityRef.current, source.id)._tag !== "available") return;
      // The target is captured now, before the request leaves: the answer belongs to this target,
      // whatever the availability has become by the time it lands.
      const target: ChangeReadTarget = {
        source: source.id,
        generation: availabilityRef.current.entries[source.id]?.generation ?? "",
        status: statusTagOf(availabilityRef.current.entries, source.id),
      };
      const currentTarget = (): boolean =>
        changeReadStillCurrent(
          target,
          sourcesRef.current.map((known) => known.id),
          availabilityRef.current.entries,
        );
      const seq = (reads.current.get(source.id) ?? 0) + 1;
      reads.current.set(source.id, seq);
      try {
        const list = await changesOf(owner.clientFor(source.id), source);
        if (reads.current.get(source.id) !== seq) return;
        // A retarget or an outage while it was in flight: this answer is not the current target's.
        if (!currentTarget()) return;
        setBySource((all) => ({ ...all, [source.id]: { changes: list, stale: false, generation: target.generation } }));
        setError(null);
      } catch (failure) {
        if (reads.current.get(source.id) !== seq) return;
        if (!currentTarget()) return;
        setBySource((all) => (all[source.id] === undefined ? all : { ...all, [source.id]: { ...all[source.id]!, stale: true } }));
        // A gate transition is the banner's job, not the page's: a checking/unavailable/cancelled
        // read is expected while the workspace is away. A real failure — or an uncertain write,
        // which a read never is — is surfaced.
        const gate = gateFailureOf(failure);
        if (gate === undefined || gate.kind === "uncertain") {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }
    },
    [owner],
  );

  const reload = useCallback(async (): Promise<void> => {
    await Promise.all(sourcesRef.current.map((source) => readSource(source)));
  }, [readSource]);

  useEffect(() => {
    void reload();
  }, [reload, sources]);
  // A source that just became available (recovery) is read; one that is checking or unavailable
  // is left alone so no request is issued against the gate.
  useEffect(() => {
    for (const source of sources) {
      if (source.id === "") continue;
      const entry = availability.entries[source.id];
      const generation = entry?.generation ?? "";
      const available = entry?.status._tag === "available";
      setBySource((all) => {
        const existing = all[source.id];
        // A retargeted target's list was never the new target's: drop it rather than carry it.
        if (existing !== undefined && existing.generation !== generation) {
          const next = { ...all };
          delete next[source.id];
          return next;
        }
        // A same-target outage keeps the last known list, marked stale so a reader knows it is
        // not a current answer.
        if (available || existing === undefined || existing.stale) return all;
        return { ...all, [source.id]: { ...existing, stale: true } };
      });
      if (available) void readSource(source);
    }
  }, [availability, sources, readSource]);
  // Removing a source drops its entry and its in-flight ticket, so a late answer cannot bring it
  // back.
  useEffect(() => {
    const ids = new Set(sources.map((source) => source.id));
    setBySource((all) => {
      const kept: Record<string, SourceChanges> = {};
      let changed = false;
      for (const [id, entry] of Object.entries(all)) {
        if (ids.has(id)) kept[id] = entry;
        else changed = true;
      }
      return changed ? kept : all;
    });
    for (const id of [...reads.current.keys()]) if (!ids.has(id)) reads.current.delete(id);
  }, [sources]);

  const reloadChanges = useCallback((): void => void reload(), [reload]);
  useServerEvent("changes", reloadChanges);
  useServerEvent(
    "source",
    useCallback(
      (data: string): void => {
        // A remote event names its source: read that one, not every source.
        if (data !== "") {
          try {
            const envelope = JSON.parse(data) as { source?: unknown };
            const named = sourcesRef.current.find((source) => source.id === envelope.source);
            if (named !== undefined) {
              void readSource(named);
              return;
            }
          } catch {
            // fall through to a full read
          }
        }
        void reload();
      },
      [readSource, reload],
    ),
  );

  const changes = useMemo(() => {
    const flat: Change[] = [];
    for (const source of sources) flat.push(...(bySource[source.id]?.changes ?? []));
    return flat;
  }, [bySource, sources]);
  const staleSources = useMemo(
    () => Object.entries(bySource).filter(([, entry]) => entry.stale).map(([id]) => id),
    [bySource],
  );

  return { changes, error, staleSources, reload };
}
