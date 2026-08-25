import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Change, type ProvisionResult } from "./api.ts";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { ChangeCard } from "./ChangeCard.tsx";
import { Leftovers } from "./Leftovers.tsx";
import { moment } from "./moment.ts";
import { Wizard } from "./Wizard.tsx";
import { ChangeView } from "./ChangeView.tsx";

/** Three views, switched by state: a router library would add a dependency to save nothing. */
type View =
  | { name: "home" }
  | { name: "new" }
  | { name: "change"; id: string; provision?: ProvisionResult[] };

function Home({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  // undefined until the list has been read: "none yet" and "not known yet" are different things.
  const [changes, setChanges] = useState<Change[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<Change[]>("/changes")
        .then(setChanges)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => void load(), [load]);

  // Names come with the list (they are stored in change.json), so the page is complete at once;
  // this only refreshes them from Jira, in one query for every change on the page.
  useEffect(() => {
    if (!changes) return;
    api<Record<string, string>>("/titles")
      .then((titles) =>
        setChanges((current) =>
          current?.map((c) => (titles[c.id] ? { ...c, title: titles[c.id] } : c)),
        ),
      )
      .catch(() => {});
    // Once per visit: a ticket is not renamed while you look at the list.
  }, [changes !== undefined]);

  // Two lists, because they are read for different reasons: what is going on, and what happened.
  const active = (changes ?? []).filter((c) => c.state !== "Completed");
  const completed = (changes ?? []).filter((c) => c.state === "Completed");

  return (
    <div className="page">
      <header>
        <Breadcrumb onHome={() => {}} />
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

      {completed.length > 0 && (
        <>
          <h2 className="section">Completed changes</h2>
          <table className="table">
            <thead>
              <tr>
                {/* No state column: every row here is Completed, which is what the heading says. */}
                <th>Change</th>
                {/* What the work was, not what the branch was called: the branch stands in only
                    when there is no ticket to ask. */}
                <th>Story</th>
                <th>Repositories</th>
                <th>Created</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {completed.map((c) => (
                <tr key={c.id} onClick={() => onOpen(c.id)}>
                  <td>{c.id}</td>
                  <td className="summary">{c.title ?? c.branch}</td>
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

/** The URL is the view: /new, /changes/<id>, everything else is home. */
function viewOf(path: string): View {
  if (path === "/new") return { name: "new" };
  const id = /^\/changes\/([^/]+)/.exec(path)?.[1];
  return id ? { name: "change", id: decodeURIComponent(id) } : { name: "home" };
}

const pathOf = (view: View): string =>
  view.name === "new"
    ? "/new"
    : view.name === "change"
      ? `/changes/${encodeURIComponent(view.id)}`
      : "/";

function App() {
  const [view, setViewState] = useState<View>(() => viewOf(window.location.pathname));

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
      {view.name === "home" && (
        <Home
          onOpen={(id) => setView({ name: "change", id })}
          onNew={() => setView({ name: "new" })}
        />
      )}
      {view.name === "new" && (
        <Wizard
          onHome={() => setView({ name: "home" })}
          onCreated={(c, provision) => setView({ name: "change", id: c.id, provision })}
          onCancel={() => setView({ name: "home" })}
        />
      )}
      {view.name === "change" && (
        <ChangeView
          id={view.id}
          provision={view.provision}
          onHome={() => setView({ name: "home" })}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
