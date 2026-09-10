import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { getPref, setPref } from "./prefs.ts";
import type { Change } from "./api.ts";
import type { Platform } from "./newWindowKey.ts";

export type Workspace = {
  id: string;
  name: string;
  reposStart?: string;
  /** `false` when this context has no Jira, and no ticket to pick in the wizard. */
  jira?: false | { project?: string; board?: string; configFile?: string; tokenEnv?: string };
  /** `false` when it has no pipelines: on load this folds into the extensions list without
   * `deployments` (src/extensions/index.ts), so the page is not offered. */
  azure?: false | { organization?: string; project?: string };
  env?: Record<string, string>;
};

/** "Everything, whichever context it belongs to" — a filter rather than a workspace, which is
 * why it is not one. */
export const ALL = "*";

/** What stands in when nothing is configured — the same default src/config.ts creates, by the
 * same reasoning. Duplicated rather than imported: that file is the server's, and this one runs
 * in the browser. */
export const DEFAULT_WORKSPACE: Workspace = { id: "default", name: "Default workspace" };

// A cookie rather than localStorage: the app serves itself from a fresh port every launch, and
// localStorage is scoped to the port (see prefs.ts).
const CHOSEN = "iwe:workspace";

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
    api<{ workspaces: Workspace[]; platform: Platform }>("/workspaces")
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
export type PageInfo = { id: string; title: string; extension: string };

/** The pages a context's sidebar offers, asked of the server (`/api/pages`) — that is where
 * the extensions and their enablement are known, so this is the same question the wizard asks
 * of `/api/wizard`. Asked again whenever the context changes, and on demand through `reload`
 * (a settings save toggles enablement without changing the context, which is why the settings
 * page calls it). A fetch that fails keeps the last good pages rather than clearing them — no
 * answer yet is the previous answer still; the next fetch or event tick recovers. */
export function usePages(workspaceId?: string): { pages: PageInfo[]; reload: () => void } {
  const [pages, setPages] = useState<PageInfo[]>([]);
  useEffect(() => {
    // Alive guards the context-change race: only the latest fetch may answer.
    let alive = true;
    api<{ pages: PageInfo[] }>(
      `/pages${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
    )
      .then((r) => {
        if (alive) setPages(r.pages);
      })
      .catch(() => {}); // no answer yet: the last good pages stand, the next fetch recovers
    return () => {
      alive = false;
    };
  }, [workspaceId]);
  const reload = useCallback(() => {
    api<{ pages: PageInfo[] }>(
      `/pages${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
    )
      .then((r) => setPages(r.pages))
      .catch(() => {}); // no answer yet: the last good pages stand, the next fetch recovers
  }, [workspaceId]);
  return { pages, reload };
}

/**
 * Which context a change belongs to. Changes made before workspaces existed have none, and
 * belong to the first one — that is what everyone's existing changes are.
 */
export const workspaceOf = (change: Change, workspaces: Workspace[]): string =>
  change.workspace ?? workspaces[0]?.id ?? ALL;

/** The changes of one context, or all of them. */
export const inWorkspace = (changes: Change[], chosen: string, workspaces: Workspace[]): Change[] =>
  chosen === ALL ? changes : changes.filter((c) => workspaceOf(c, workspaces) === chosen);
