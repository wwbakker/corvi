import { type JSX, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Change, type ProvisionResult } from "./api.ts";
import { byWorkOrder, isFinished } from "../domain/change.ts";
import { stateClass } from "./stateClass.ts";
import { ChangeCard } from "./ChangeCard.tsx";
import { moment } from "./moment.ts";
import { Sidebar, type Page } from "./Sidebar.tsx";
import { useChanges, useTerminal, useWindows } from "./state.ts";
import { inWorkspace, usePages, useWorkspaces } from "../workspace/client/workspaces.ts";
import { Wizard } from "../wizard/index.ts";
import { ChangeView } from "../change-page/client/ChangeView.tsx";
import { PageHost } from "../extension-host/client.tsx";
import { SettingsPage } from "../settings/client/SettingsPage.tsx";
import { Notifier } from "./notify.tsx";

/** Three views, switched by state: a router library would add a dependency to save nothing. */
type View =
  | { name: "home" }
  | { name: "new" }
  | { name: "ext-page"; id: string; extension: string }
  | { name: "settings" }
  | { name: "change"; id: string; page: Page; provision?: ProvisionResult[] };

function Home({
  changes,
  error,
  onOpen,
  onNew,
}: {
  // undefined until the list has been read: "none yet" and "not known yet" are different things.
  changes: Change[] | undefined;
  error: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}): JSX.Element {
  // Two lists, because they are read for different reasons: what is going on, and what happened.
  // The active ones in work order — what you can get on with, then what is with somebody else,
  // then what is stuck — newest first within each.
  const active = (changes ?? []).filter((c) => !isFinished(c)).sort(byWorkOrder);
  const finished = (changes ?? [])
    .filter(isFinished)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  return (
    <div className="page">
      <header>
        <h2>Changes</h2>
        <span className="spacer" />
        <button className="create" onClick={onNew}>
          New change
        </button>
      </header>
      {error && <div className="error-banner">{error}</div>}

      <h2 className="section">Active changes</h2>
      {!changes && !error && <p className="hint">loading…</p>}
      {changes && active.length === 0 && <p className="hint">nothing in progress</p>}
      <div className="change-cards">
        {active.map((c) => (
          <ChangeCard key={c.id} change={c} onOpen={() => onOpen(c.id)} />
        ))}
      </div>

      {finished.length > 0 && (
        <>
          {/* Not "Completed": a cancelled change is finished too, and the difference is the
              first thing you want to know about a row down here. */}
          <h2 className="section">Finished changes</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Change</th>
                <th>Story</th>
                <th>How it ended</th>
                <th>Repositories</th>
                <th>Created</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {finished.map((c) => (
                <tr key={c.id} onClick={() => onOpen(c.id)}>
                  <td>{c.id}</td>
                  <td className="summary">{c.title ?? c.branch}</td>
                  <td className={stateClass(c.state)}>{c.state ?? "Completed"}</td>
                  <td>{c.repos.length}</td>
                  <td>{moment(c.createdAt)}</td>
                  <td>{c.completedAt ? moment(c.completedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** The URL is the view: /new, /changes/<id>[/<page>], /<page> for an extension's page,
 * everything else is home. The change's page segment is kept as it is — the core's `dashboard`
 * and `terminals`, or a tab an extension contributes — and ChangeView resolves an id nobody
 * offers to the dashboard, so a stale URL still renders something. The pages are the server's
 * (`/api/pages`), so a top-level path resolves only once they are known — until then it is
 * home, and the resolution is redone when they arrive. */
function viewOf(path: string, pages: { id: string; extension: string }[] = []): View {
  if (path === "/new") return { name: "new" };
  if (path === "/settings") return { name: "settings" };
  const m = /^\/changes\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (!m) {
    // A top-level path that names a page the server offered: the extension's own view. A path
    // that is not a well-formed encoding was never a page, and is home.
    if (!path.slice(1).includes("/")) {
      const raw = path.slice(1);
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        return { name: "home" };
      }
      const page = pages.find((p) => p.id === id);
      if (page) return { name: "ext-page", id: page.id, extension: page.extension };
    }
    return { name: "home" };
  }
  const page = m[2] ?? "dashboard";
  return { name: "change", id: decodeURIComponent(m[1]!), page };
}

const pathOf = (view: View): string =>
  view.name === "new"
    ? "/new"
    : view.name === "ext-page"
      ? `/${view.id}`
      : view.name === "settings"
        ? "/settings"
        : view.name === "change"
          ? `/changes/${encodeURIComponent(view.id)}${view.page === "dashboard" ? "" : `/${view.page}`}`
          : "/";

function App(): JSX.Element {
  const [view, setViewState] = useState<View>(() => viewOf(window.location.pathname));
  const { changes: everything, error, reload } = useChanges();
  const { workspaces, chosen, choose, current: workspace, ready, platform, reload: reloadWorkspaces } = useWorkspaces();
  // The pages the sidebar offers in this context, from the server: which extensions exist and
  // what they contribute is not the page's to know. Undefined ("All work") is the server's
  // default context, which is what a request without a workspace gets.
  const { pages, reload: reloadPages } = usePages(workspace?.id);
  // One context at a time: the lists, the overview and what a new change is made in. Undefined
  // until the contexts are known, which reads as "loading" rather than as "everything".
  const changes = everything && ready ? inWorkspace(everything, chosen, workspaces) : undefined;

  const selected = view.name === "change" ? view.id : null;
  // Found among all of them, not the filtered list: a link to a change in another workspace
  // should open it rather than say it does not exist.
  const change = (everything ?? []).find((c) => c.id === selected);
  const onTerminal = view.name === "change" && view.page === "terminals";
  // The terminals belong to the changes, not to the page you are on: the column lists every
  // change's windows, whichever change you are looking at. Pushed by the server, so this costs
  // one connection and no polling.
  const terminals = useWindows();
  // Only once a terminal is asked for: opening a dashboard is not asking for one.
  const [wantsTerminal, setWantsTerminal] = useState(false);
  useEffect(() => setWantsTerminal(false), [selected]);
  useEffect(() => {
    if (onTerminal) setWantsTerminal(true);
  }, [onTerminal]);
  const terminal = useTerminal(selected, Boolean(change?.completedAt), wantsTerminal);

  // Navigating pushes a history entry; Back and a reload both land on the same page.
  const setView = (next: View): void => {
    if (pathOf(next) !== window.location.pathname) window.history.pushState(null, "", pathOf(next));
    setViewState(next);
  };

  // A notification click comes back through the host as a plain function: activate the window,
  // then open the change and the tmux window it was about. The window id is looked up in the
  // live list, because the index it had when the notification was made may belong to another
  // window by the time it is clicked.
  const openWindow = (change: string, windowId: string): void => {
    const index = (terminals.windows[change] ?? []).find((w) => w.id === windowId)?.index;
    setWantsTerminal(true);
    setView({ name: "change", id: change, page: "terminals" });
    if (index !== undefined) terminals.select(change, index);
  };
  const openWindowRef = useRef(openWindow);
  openWindowRef.current = openWindow;
  useEffect(() => {
    // The contract the host calls after the notification is clicked; the wrapper keeps the
    // registered function from going stale as the view changes.
    const api = {
      openWindow: (change: string, windowId: string) => openWindowRef.current(change, windowId),
    };
    (window as unknown as { iwe?: typeof api }).iwe = api;
    return () => {
      delete (window as unknown as { iwe?: typeof api }).iwe;
    };
  }, []);

  useEffect(() => {
    const onPop = (): void => setViewState(viewOf(window.location.pathname, pagesRef.current));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The pages are the server's, and they may arrive after the first view was resolved: a link
  // or a reload on /azure-devops reads as home until then. Once known, the URL is re-read — the
  // URL is the truth, and this only ever makes it match.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => {
    setViewState(viewOf(window.location.pathname, pages));
  }, [pages]);

  return (
    <div className="app">
      <Notifier
        change={selected}
        page={view.name === "change" ? view.page : "dashboard"}
        windows={selected ? (terminals.windows[selected] ?? []) : []}
        onOpen={openWindow}
      />
      <Sidebar
        changes={changes}
        workspaces={workspaces}
        chosen={chosen}
        onChooseWorkspace={choose}
        current={change ?? (selected ? ({ id: selected } as Change) : undefined)}
        page={view.name === "change" ? view.page : "dashboard"}
        windows={terminals.windows}
        onHome={() => setView({ name: "home" })}
        // The server's pages, offered as they are: which extensions exist here is not the
        // page's to know.
        pages={pages}
        onPage={(id) => {
          const page = pages.find((p) => p.id === id);
          if (page) setView({ name: "ext-page", id: page.id, extension: page.extension });
        }}
        extPage={view.name === "ext-page" ? view.id : undefined}
        onSettings={() => setView({ name: "settings" })}
        settings={view.name === "settings"}
        // Key hints are the server's platform's business: it is that machine's shell the
        // terminal runs in.
        platform={platform}
        onOpenChange={(id) => setView({ name: "change", id, page: "dashboard" })}
        onSelectWindow={(id, index) => {
          terminals.select(id, index);
          setWantsTerminal(true);
          setView({ name: "change", id, page: "terminals" });
        }}
        onNewWindow={(id) => {
          // A change whose session has not started yet has nothing to add a window to: opening
          // its terminal starts one, with the window you were asking for.
          if ((terminals.windows[id] ?? []).length > 0) void terminals.create(id);
          setWantsTerminal(true);
          setView({ name: "change", id, page: "terminals" });
        }}
      />
      <main className={onTerminal ? "content flush" : "content"}>
        {view.name === "home" && (
          <Home
            changes={changes}
            error={error}
            onOpen={(id) => setView({ name: "change", id, page: "dashboard" })}
            onNew={() => setView({ name: "new" })}
          />
        )}
        {view.name === "ext-page" && (
          <PageHost info={view} workspace={workspace?.id} />
        )}
        {view.name === "settings" && (
          <SettingsPage
            onSaved={() => {
              // A save may have toggled an extension's enablement, which the workspaces carry
              // and the sidebar's pages answer to — both are asked again.
              reloadWorkspaces();
              reloadPages();
            }}
          />
        )}
        {view.name === "new" && (
          <Wizard
            workspaces={workspaces}
            workspace={workspace?.id}
            onCreated={(c, provision) => {
              void reload();
              setView({ name: "change", id: c.id, page: "dashboard", provision });
            }}
            onCancel={() => setView({ name: "home" })}
          />
        )}
        {view.name === "change" && (
          <ChangeView
            id={view.id}
            page={view.page}
            platform={platform}
            provision={view.provision}
            onOpenPage={(page) => setView({ ...view, page, provision: undefined })}
            terminal={{ ...terminal, create: () => void terminals.create(view.id) }}
            windows={terminals.windows[view.id] ?? []}
            onSelectWindow={(index) => {
              terminals.select(view.id, index);
              setWantsTerminal(true);
              // On the dashboard the tab is the way in: selecting a window you cannot see would
              // be a click that does nothing visible.
              setView({ name: "change", id: view.id, page: "terminals" });
            }}
            onNewWindow={() => {
              // A session that has not started has nothing to add a window to: opening the
              // terminal makes its first window.
              if ((terminals.windows[view.id] ?? []).length > 0) void terminals.create(view.id);
              setWantsTerminal(true);
              setView({ name: "change", id: view.id, page: "terminals" });
            }}
            onMoveWindow={(from, to) => terminals.move(view.id, from, to)}
            onChanged={reload}
          />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
