/** The servers this page talks to: the local one, and one per remote workspace.
 *
 * The local server is the single origin the page is served from; a remote workspace is reached
 * through its gateway prefix (`/remote/<workspace-id>`), which injects the device token. A
 * `Source` is therefore just an id and a base URL, and the token never reaches the page.
 *
 * The clients and the availability gate are owned by one `SourceOwner` per provider — never a
 * module-level singleton — so an owner's lifetime is the provider's and two mounts are
 * independent. `clientFor`/`wireFor` are reached through `useSourceOwner()` (or the
 * change/workspace hooks), which is what makes the gate cover every remote caller.
 */
import type { CorviClient, WireClient } from "@corvi/client";
import type { WorkspaceDto } from "@corvi/contracts/config";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { apiClient } from "./api.ts";
import { useServerEvent } from "./events.ts";
import {
  makeSourceOwner,
  statusOf,
  type OwnerAvailability,
  type SourceOwner,
} from "./sourceOwner.ts";

/** One server the page can reach. `id` is `""` for the local server and the local workspace id
 * for a remote one. */
export type Source = {
  readonly id: string;
  readonly baseUrl: string;
  /** A remote source's workspace id on ITS server: which of its changes belong to this source.
   * Undefined for the local server, which keeps every change. */
  readonly remoteWorkspace?: string;
};

export const LOCAL_SOURCE: Source = { id: "", baseUrl: "" };

/** A source by id, without the workspace list: enough to build a base URL. */
export const sourceOf = (id: string): Source =>
  id === "" ? LOCAL_SOURCE : { id, baseUrl: `/remote/${encodeURIComponent(id)}` };

/** A change's identity across sources: two servers can mint the same id. */
export const changeKey = (source: string, id: string): string => `${source}\n${id}`;

/** The source a rendered change belongs to, for the components nested under its page. The change
 * page provides it, so a card deep in the tree reaches the owning server without threading the
 * source through every prop. */
export const SourceContext = createContext<string>("");

/** The source id a rendered change belongs to. */
export const useSource = (): string => useContext(SourceContext);

/** The source a workspace-scoped extension page is rendered for: `""` for the local server, a
 * remote workspace's local id for a remote one. Unlike the change context (a change carries its
 * own source), this is provided once around the page host, where the selection is; the page gets
 * the workspace id to send as a prop — already the remote's own id there. */
export const WorkspaceSourceContext = createContext<string>("");

/** The source a rendered workspace page belongs to. */
export const useWorkspaceSource = (): string => useContext(WorkspaceSourceContext);

/** The sources a workspace list names: the local server, then one per remote workspace. */
export const sourcesFrom = (workspaces: readonly WorkspaceDto[]): Source[] => [
  LOCAL_SOURCE,
  ...workspaces
    .filter((workspace) => workspace.remote !== undefined)
    .map((workspace) => ({
      id: workspace.id,
      baseUrl: `/remote/${encodeURIComponent(workspace.id)}`,
      remoteWorkspace: workspace.remote!.workspace,
    })),
];

/** The sources this page talks to, their owner, and the availability the owner has established.
 * One provider, so every consumer shares one request and one gate. */
export type SourcesState = {
  sources: Source[];
  ready: boolean;
  reload: () => void;
  owner: SourceOwner;
};

const SourcesContext = createContext<SourcesState | null>(null);

export function SourcesProvider({ children }: { children: ReactNode }): ReactElement {
  const [sources, setSources] = useState<Source[]>([LOCAL_SOURCE]);
  const [ready, setReady] = useState(false);
  const ownerRef = useRef<SourceOwner | null>(null);
  if (ownerRef.current === null) {
    ownerRef.current = makeSourceOwner({
      local: apiClient.remotes,
      baseUrlOf: (id) => sourceOf(id).baseUrl,
    });
  }
  const owner = ownerRef.current;

  const reload = useCallback((): void => {
    apiClient.workspaces
      .list()
      .then(({ workspaces }) => setSources(sourcesFrom(workspaces)))
      .catch(() => {}) // no answer yet: the local source stands
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);
  // The owner's lifetime is the provider's, but disposal is deferred by a tick: React's
  // StrictMode remount runs this cleanup and then the effect again synchronously, so disposing
  // on the spot would leave the remounted tree driving a dead owner (effects re-run, the render
  // does not, so a ref-null cannot hand out a fresh one). A real unmount leaves the timer to
  // fire. The ref is cleared with the disposal, so any later render builds a fresh owner.
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(disposeTimer.current);
    return () => {
      disposeTimer.current = setTimeout(() => {
        disposeTimer.current = undefined;
        owner.dispose();
        if (ownerRef.current === owner) ownerRef.current = null;
      }, 0);
    };
  }, [owner]);
  // Availability is discovered from the local server and its one event stream only — never by
  // asking a remote — so a slow remote cannot delay it. The owner is stable, so this subscribes
  // once.
  useServerEvent("availability", owner.applyEvent);
  useEffect(() => {
    owner.refresh();
  }, [owner]);

  return createElement(
    SourcesContext.Provider,
    { value: { sources, ready, reload, owner } },
    children,
  );
}

/** The provider state; throws outside the provider, because there is no defensible fallback for
 * an owner that carries clients and the gate. */
export const useSources = (): SourcesState => {
  const state = useContext(SourcesContext);
  if (state === null) throw new Error("useSources must be used inside SourcesProvider");
  return state;
};

/** The page's source owner: clients, gate, and availability. */
export const useSourceOwner = (): SourceOwner => useSources().owner;

/** The availability epoch and per-source entries, as a subscription. */
export const useAvailability = (): OwnerAvailability => {
  const owner = useSourceOwner();
  return useSyncExternalStore(owner.subscribe, owner.availability, owner.availability);
};

/** One source's reachability. Local is always `available`; a configured remote with no answer
 * yet is `checking`; the retry asks the server for one coordinated check. */
export const useSourceAvailability = (
  source: string,
): { status: ReturnType<typeof statusOf>; generation: string; retry: () => void } => {
  const owner = useSourceOwner();
  const availability = useAvailability();
  return {
    status: statusOf(availability, source),
    generation: availability.entries[source]?.generation ?? "",
    // A failed retry (the local route is down, the source is unknown) must not become an
    // unhandled rejection; the state it left is what the surfaces show.
    retry: useCallback(() => {
      void owner.retry(source).catch(() => undefined);
    }, [owner, source]),
  };
};

/** The client for a source, gated by that source's availability. */
export const useSourceClient = (source: string): CorviClient => useSourceOwner().clientFor(source);

/** The client for the rendered change's source: what a change-scoped call should use. */
export const useChangeClient = (): CorviClient => useSourceClient(useSource());

/** The extension-local transport for the rendered change's source: an integration's browser half
 * reaches its own routes through the same gateway prefix and the same gate. */
export const useChangeWireClient = (): WireClient => useSourceOwner().wireFor(useSource());

/** A tick that changes when a source is retargeted or recovers from being unreachable — never
 * when it merely goes unreachable. A page whose load effect keys on the transport's identity
 * re-reads on recovery without being unmounted, and keeps its loaded facts through the outage
 * (the same generation's last answer stands while the banner explains). */
const useRecoveryTick = (source: string): number => {
  const availability = useAvailability();
  const entry = availability.entries[source];
  const status = source === "" ? "available" : (entry?.status._tag ?? "checking");
  const generation = entry?.generation ?? "";
  const previous = useRef({ source, generation, status });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const prev = previous.current;
    previous.current = { source, generation, status };
    const retargeted = prev.source !== source || prev.generation !== generation;
    const recovered = prev.source === source && prev.status !== "available" && status === "available";
    if (retargeted || recovered) setTick((n) => n + 1);
  }, [source, generation, status]);
  return tick;
};

/** The extension-local transport for a workspace-scoped page, through the same gate. Its
 * identity carries the target and its recovery, so a page's load effect re-reads the moment its
 * workspace comes back instead of waiting its poll out (or, for a page with no poll, never). */
export const useWorkspaceWireClient = (): WireClient => {
  const owner = useSourceOwner();
  const source = useWorkspaceSource();
  const base = owner.wireFor(source);
  const tick = useRecoveryTick(source);
  return useMemo(() => ({ request: base.request }), [base, tick]);
};
