import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Change, type ProvisionResult } from "./api.ts";
import { byWorkOrder, isFinished } from "../types.ts";
import { stateClass } from "./changeState.tsx";
import { ChangeCard } from "./ChangeCard.tsx";
import { Leftovers } from "./Leftovers.tsx";
import { moment } from "./moment.ts";
import { Sidebar, type Page } from "./Sidebar.tsx";
import { useChanges, useTerminal, useWindows } from "./state.ts";
import { inWorkspace, useWorkspaces } from "./workspaces.ts";
import { Wizard } from "./Wizard.tsx";
import { ChangeView } from "./ChangeView.tsx";
import { DeploymentsPage } from "./DeploymentsPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

/** Three views, switched by state: a router library would add a dependency to save nothing. */
type View =
  | { name: "home" }
  | { name: "new" }
  | { name: "deployments" }
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
}) {
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
      <Leftovers />
    </div>
  );
}

/** The URL is the view: /new, /changes/<id>[/terminals|/local], everything else is home. */
function viewOf(path: string): View {
  if (path === "/new") return { name: "new" };
  if (path === "/deployments") return { name: "deployments" };
  if (path === "/settings") return { name: "settings" };
  const m = /^\/changes\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (!m) return { name: "home" };
  const page = m[2] === "terminals" || m[2] === "review" ? m[2] : "dashboard";
  return { name: "change", id: decodeURIComponent(m[1]!), page };
}

const pathOf = (view: View): string =>
  view.name === "new"
    ? "/new"
    : view.name === "deployments"
      ? "/deployments"
      : view.name === "settings"
        ? "/settings"
        : view.name === "change"
          ? `/changes/${encodeURIComponent(view.id)}${view.page === "dashboard" ? "" : `/${view.page}`}`
          : "/";

function App() {
  const [view, setViewState] = useState<View>(() => viewOf(window.location.pathname));
  const { changes: everything, error, reload } = useChanges();
  const { workspaces, chosen, choose, current: workspace, ready, reload: reloadWorkspaces } = useWorkspaces();
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
  // one connection rather than a request per page per second and a half.
  const terminals = useWindows();
  // Only once a terminal is asked for: opening a dashboard is not asking for one.
  const [wantsTerminal, setWantsTerminal] = useState(false);
  useEffect(() => setWantsTerminal(false), [selected]);
  useEffect(() => {
    if (onTerminal) setWantsTerminal(true);
  }, [onTerminal]);
  const terminal = useTerminal(selected, Boolean(change?.completedAt), wantsTerminal);

  // Navigating pushes a history entry; Back and a reload both land on the same page.
  const setView = (next: View) => {
    if (pathOf(next) !== window.location.pathname) window.history.pushState(null, "", pathOf(next));
    setViewState(next);
  };

  useEffect(() => {
    const onPop = () => setViewState(viewOf(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div className="app">
      <Sidebar
        changes={changes}
        workspaces={workspaces}
        chosen={chosen}
        onChooseWorkspace={choose}
        current={change ?? (selected ? ({ id: selected } as Change) : undefined)}
        page={view.name === "change" ? view.page : "dashboard"}
        windows={terminals.windows}
        onHome={() => setView({ name: "home" })}
        onDeployments={() => setView({ name: "deployments" })}
        deployments={view.name === "deployments"}
        onSettings={() => setView({ name: "settings" })}
        settings={view.name === "settings"}
        // A context with no pipelines has nothing to show on that page, so it is not offered.
        hasDeployments={workspace?.azure !== false}
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
      <main className="content">
        {view.name === "home" && (
          <Home
            changes={changes}
            error={error}
            onOpen={(id) => setView({ name: "change", id, page: "dashboard" })}
            onNew={() => setView({ name: "new" })}
          />
        )}
        {view.name === "deployments" && <DeploymentsPage workspace={workspace?.id} />}
        {view.name === "settings" && <SettingsPage onSaved={reloadWorkspaces} />}
        {view.name === "new" && (
          <Wizard
            workspace={workspace?.id}
            hasJira={workspace?.jira !== false}
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
            provision={view.provision}
            onOpenPage={(page) => setView({ ...view, page, provision: undefined })}
            terminal={{ ...terminal, create: () => void terminals.create(view.id) }}
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
