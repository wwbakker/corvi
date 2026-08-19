import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Change, type ProvisionResult } from "./api.ts";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { stateClass } from "./changeState.tsx";
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
      <table className="table">
        <thead>
          <tr>
            <th>Change</th>
            <th>State</th>
            <th>Branch</th>
            <th>Jira</th>
            <th>Repositories</th>
            <th>Created</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {(changes ?? []).map((c) => (
            <tr key={c.id} onClick={() => onOpen(c.id)}>
              <td>{c.id}</td>
              <td className={stateClass(c.state)}>{c.state ?? "In Progress"}</td>
              <td>{c.branch}</td>
              <td>{c.jira ?? "—"}</td>
              <td>{c.repos.length}</td>
              <td>{c.createdAt.slice(0, 10)}</td>
              <td>{c.completedAt ? c.completedAt.slice(0, 10) : "—"}</td>
            </tr>
          ))}
          {changes?.length === 0 && (
            <tr>
              <td colSpan={7}>no changes yet</td>
            </tr>
          )}
          {!changes && !error && (
            <tr>
              <td colSpan={7} className="hint">
                loading…
              </td>
            </tr>
          )}
        </tbody>
      </table>
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
