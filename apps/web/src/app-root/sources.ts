/** The servers this page talks to: the local one, and one per remote workspace.
 *
 * The local server is the single origin the page is served from; a remote workspace is reached
 * through its gateway prefix (`/remote/<workspace-id>`), which injects the device token. A
 * `Source` is therefore just an id and a base URL, and the token never reaches the page.
 *
 * A change's identity across sources is `(source, id)`: two servers can mint the same id, so a
 * map keyed by change id alone (the terminal windows) is keyed by `changeKey` instead.
 */
import { makeCorviClient, makeWireClient, type CorviClient, type WireClient } from "@corvi/client";
import type { WorkspaceDto } from "@corvi/contracts/config";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { apiClient } from "./api.ts";

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

const clients = new Map<string, CorviClient>();
const wireClients = new Map<string, WireClient>();

/** The client for a source id: cached, and relative to this origin, so the gateway carries the
 * remote's token. */
export const clientFor = (source: string): CorviClient => {
  let client = clients.get(source);
  if (client === undefined) {
    client = makeCorviClient({ baseUrl: sourceOf(source).baseUrl });
    clients.set(source, client);
  }
  return client;
};

/** A change's identity across sources: two servers can mint the same id. */
export const changeKey = (source: string, id: string): string => `${source}\n${id}`;

/** The source a rendered change belongs to, for the components nested under its page. The change
 * page provides it, so a card deep in the tree reaches the owning server without threading the
 * source through every prop. */
export const SourceContext = createContext<string>("");

const wireFor = (source: string): WireClient => {
  let wire = wireClients.get(source);
  if (wire === undefined) {
    wire = makeWireClient({ baseUrl: sourceOf(source).baseUrl });
    wireClients.set(source, wire);
  }
  return wire;
};

/** The source id a rendered change belongs to. */
export const useSource = (): string => useContext(SourceContext);

/** The source a workspace-scoped extension page is rendered for: `""` for the local server, a
 * remote workspace's local id for a remote one. Unlike the change context (a change carries its
 * own source), this is provided once around the page host, where the selection is; the page gets
 * the workspace id to send as a prop — already the remote's own id there. */
export const WorkspaceSourceContext = createContext<string>("");

/** The source a rendered workspace page belongs to. */
export const useWorkspaceSource = (): string => useContext(WorkspaceSourceContext);

/** The extension-local transport for a workspace-scoped page: its own routes on the server that
 * hosts the workspace, through the same gateway prefix as the core client. */
export const useWorkspaceWireClient = (): WireClient => wireFor(useWorkspaceSource());

/** The extension-local transport for the rendered change's source: an integration's browser half
 * reaches its own routes through the same gateway prefix as the core client. */
export const useChangeWireClient = (): WireClient => wireFor(useSource());

/** The client for the rendered change's source: what a change-scoped call should use. */
export const useChangeClient = (): CorviClient => clientFor(useSource());

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

/** The sources this page talks to, from the local server's `/api/workspaces`. One provider, so
 * every consumer shares one request, and `reload` (called after a settings save) updates them
 * all at once. The local server is always first, so the page renders against it before the list
 * arrives. */
export type SourcesState = { sources: Source[]; ready: boolean; reload: () => void };

const SourcesContext = createContext<SourcesState>({
  sources: [LOCAL_SOURCE],
  ready: false,
  reload: () => {},
});

export function SourcesProvider({ children }: { children: ReactNode }): ReactElement {
  const [sources, setSources] = useState<Source[]>([LOCAL_SOURCE]);
  const [ready, setReady] = useState(false);

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

  return createElement(SourcesContext.Provider, { value: { sources, ready, reload } }, children);
}

export const useSources = (): SourcesState => useContext(SourcesContext);
