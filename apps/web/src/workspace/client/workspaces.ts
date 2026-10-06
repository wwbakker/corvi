import { useCallback, useEffect, useState } from "react";
import type { CorviClient } from "@corvi/client";
import { apiClient } from "../../app-root/api.ts";
import { getPref, setPref } from "../../app-root/prefs.ts";
import type { Platform } from "@corvi/terminals/model";
import { DEFAULT_WORKSPACE, type WorkspaceDto } from "@corvi/contracts/config";

export type Workspace = {
  id: string;
  name: string;
  /** A remote workspace's target, when this context lives on another server. */
  remote?: WorkspaceDto["remote"];
  repositoriesDirectory?: string;
  env?: Record<string, string>;
};

/** "Everything, whichever context it belongs to" — a filter rather than a workspace, which is
 * why it is not one. */
export const ALL = "*";

/** What stands in when nothing is configured — the same default the server resolves, from the
 * pure vocabulary both halves share. */
export { DEFAULT_WORKSPACE };

// A cookie rather than localStorage: the app serves itself from a fresh port every launch, and
// localStorage is scoped to the port (see prefs.ts).
const CHOSEN = "corvi:workspace";

/**
 * Which context you are working in.
 *
 * Kept in the browser rather than on the server: two windows open on two clients is a reasonable
 * thing to want, and the server has no business having an opinion about which one you are
 * looking at.
 */
export function useWorkspaces(): {
  workspaces: Workspace[];
  chosen: string;
  choose: (id: string) => void;
  current: Workspace | undefined;
  ready: boolean;
  platform: Platform;
  reload: () => void;
} {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [chosen, setChosen] = useState<string>(() => getPref(CHOSEN) ?? ALL);
  // Until this is known, no list is shown. A moment of "everything" before the filter arrives
  // would be a moment of another client's work on the screen, which is the one thing a
  // workspace exists to prevent.
  const [ready, setReady] = useState(false);
  // The server's platform, told once with the workspaces: what the key hints and shortcuts
  // should assume. "other" until then, which reads as the macOS bindings the UI always had.
  const [platform, setPlatform] = useState<Platform>("other");

  // Read again after the settings page writes them: a context that has just been renamed should
  // not still be in the switcher under its old name.
  const reload = (): Promise<void> =>
    apiClient
      .workspaces.list()
      .then(({ workspaces: next, platform: told }) => {
        setWorkspaces(next);
        setPlatform(told);
      })
      .catch(() => {}) // no workspaces is the same as one: everything
      .finally(() => setReady(true));

  useEffect(() => {
    void reload();
  }, []);

  const choose = (id: string): void => {
    setPref(CHOSEN, id);
    setChosen(id);
  };

  // A workspace that was removed from the config is not a filter any more — but only once we
  // know what the workspaces are.
  const current = workspaces.find((w) => w.id === chosen);
  return {
    workspaces,
    chosen: !ready || current ? chosen : ALL,
    choose,
    current,
    ready,
    platform,
    reload: () => void reload(),
  };
}

/** One page the sidebar offers, as the server names it: the extension it belongs to travels
 * with it, because that is who renders it. */
export type PageInfo = { id: string; title: string; icon?: string; extension: string };

/** The pages a context's sidebar offers, asked of the server (`/api/pages`) — that is where
 * the extensions and their enablement are known, so this is the same question the wizard asks
 * of `/api/wizard`. Asked again whenever the context changes, and on demand through `reload`
 * (a settings save toggles enablement without changing the context, which is why the settings
 * page calls it). A fetch that fails keeps the last good pages rather than clearing them — no
 * answer yet is the previous answer still; the next fetch or event tick recovers. */
/** The extension pages a context offers, from that context's own server: which extensions exist
 * and what they contribute is not the page's to know. `client` is the workspace's source (the
 * local `apiClient` here, a gateway client for a remote workspace), and `workspaceId` is the id
 * to send THAT server — the remote's own id for a remote workspace. */
export function usePages(
  workspaceId?: string,
  client: CorviClient = apiClient,
): { pages: PageInfo[]; reload: () => void } {
  const [pages, setPages] = useState<PageInfo[]>([]);
  useEffect(() => {
    // The list belongs to one (source, workspace): switching either one must not keep showing
    // another context's pages. Clear first, so an unreachable workspace shows none rather than
    // the previous one's. The effect only re-runs when the key changes, so a reload for the same
    // workspace keeps the last good list while the next fetch is in flight.
    setPages([]);
    // Alive guards the context-change race: only the latest fetch may answer.
    let alive = true;
    client
      .workspaces.pages(workspaceId)
      .then((pages) => {
        if (alive) setPages(pages);
      })
      .catch(() => {}); // no answer yet: the list is empty rather than another context's
    return () => {
      alive = false;
    };
  }, [workspaceId, client]);
  const reload = useCallback(() => {
    client
      .workspaces.pages(workspaceId)
      .then(setPages)
      .catch(() => {}); // no answer yet: the last good pages stand, the next fetch recovers
  }, [workspaceId, client]);
  return { pages, reload };
}

/**
 * Which context a change belongs to. A change that names none belongs to the first context,
 * which is where a change written outside any workspace sits.
 */
export const workspaceOf = (
  change: { readonly workspace?: string },
  workspaces: Workspace[],
): string => change.workspace ?? workspaces[0]?.id ?? ALL;

/** The changes of one context, or all of them. */
export const inWorkspace = <T extends { readonly workspace?: string }>(
  changes: T[],
  chosen: string,
  workspaces: Workspace[],
): T[] => (chosen === ALL ? changes : changes.filter((c) => workspaceOf(c, workspaces) === chosen));
