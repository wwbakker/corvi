import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  post,
  type Change,
  type Completion,
  type IntegrationInfo,
  type ProvisionResult,
  type Widget,
  type WidgetItem,
} from "./api.ts";
import { EditReposDialog } from "./EditReposDialog.tsx";

function Dot({ state }: { state?: string }) {
  return <span className={`dot ${state ?? "none"}`} />;
}

const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** Elapsed time against the pipeline's recent average. Ticks locally so the clock is smooth
 * between the widget's 15s refreshes; overruns fill the bar and keep counting. */
function Progress({ startedAt, expectedMs }: { startedAt: string; expectedMs?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = now - new Date(startedAt).getTime();
  const fraction = expectedMs ? Math.min(elapsed / expectedMs, 1) : undefined;
  return (
    <span className="progress" title={expectedMs ? `average ${duration(expectedMs)}` : undefined}>
      <span className="bar">
        <span
          className={`fill ${fraction === undefined ? "unknown" : elapsed > (expectedMs ?? 0) ? "over" : ""}`}
          style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }}
        />
      </span>
      <span className="elapsed">
        {duration(elapsed)}
        {expectedMs ? ` / ~${duration(expectedMs)}` : ""}
      </span>
    </span>
  );
}

/** A row and its children, collapsible like a project tree. Rows are open by default: the
 * hierarchy exists to group, not to hide. */
function Item({
  item,
  onAction,
  busy,
  depth = 0,
}: {
  item: WidgetItem;
  onAction: (actionId: string, arg?: string) => void;
  busy: boolean;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const children = item.children ?? [];
  return (
    <>
      <div className={`item depth-${depth}`} style={{ paddingLeft: depth * 22 }}>
        {children.length > 0 ? (
          <button className="toggle" onClick={() => setOpen(!open)} title={open ? "Collapse" : "Expand"}>
            {open ? "−" : "+"}
          </button>
        ) : (
          <span className="toggle-spacer" />
        )}
        <Dot state={item.state} />
        <span className="label">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.label}
            </a>
          ) : (
            item.label
          )}
        </span>
        <span className={`detail ${item.detailTone ?? ""}`}>{item.detail}</span>
        {item.progress && <Progress {...item.progress} />}
        <span className="spacer" />
        {(item.actions ?? []).map((a) => (
          <button
            key={a.id + (a.arg ?? "")}
            disabled={busy}
            // Anything that could surprise asks first; the server refuses the rest outright.
            onClick={() => (!a.confirm || window.confirm(a.confirm)) && onAction(a.id, a.arg)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {open &&
        children.map((child) => (
          <Item
            key={child.label}
            item={child}
            busy={busy}
            onAction={onAction}
            depth={depth + 1}
          />
        ))}
    </>
  );
}

/** One card, loading and refreshing itself: a slow CLI delays its own widget and nothing else. */
function WidgetCard({ changeId, info }: { changeId: string; info: IntegrationInfo }) {
  const [widget, setWidget] = useState<Widget | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(
    (): Promise<void> =>
      api<Widget>(`/changes/${changeId}/${info.name}`)
        .then(setWidget)
        .catch((e: Error) =>
          setWidget({
            integration: info.name,
            title: info.title,
            state: "error",
            summary: e.message,
            items: [],
          }),
        ),
    [changeId, info.name, info.title],
  );

  useEffect(() => {
    let live = true;
    const tick = () => live && void load();
    tick();
    const timer = setInterval(tick, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load]);

  const act = (actionId: string, arg?: string): Promise<void> => {
    setBusy(true);
    return post<Widget>(`/changes/${changeId}/${info.name}/${actionId}`, { arg })
      .then(setWidget)
      .catch((e: Error) => setWidget({ ...widget!, state: "error", summary: e.message }))
      .finally(() => setBusy(false));
  };

  return (
    <section className={`widget ${widget ? "" : "loading"}`}>
      <h3>
        <Dot state={widget?.state} />
        {info.title}
        {/* The repository list belongs to the change, and git is the component that shows it. */}
        {info.name === "git" && (
          <>
            <span className="spacer" />
            <button className="icon" title="Edit repositories" onClick={() => setEditing(true)}>
              ✎
            </button>
          </>
        )}
      </h3>
      <div className="summary">{widget ? widget.summary : "loading…"}</div>
      {(widget?.items ?? []).map((item) => (
        <Item key={item.label} item={item} busy={busy} onAction={act} />
      ))}
      {info.name === "git" && (
        <EditReposDialog
          changeId={changeId}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

export function ChangeView({
  id,
  provision,
  onBack,
}: {
  id: string;
  /** Results of the creation step, shown once: it is the one moment something can fail
   * without you having clicked it. */
  provision?: ProvisionResult[];
  onBack: () => void;
}) {
  const [change, setChange] = useState<Change | null>(null);
  const [infos, setInfos] = useState<IntegrationInfo[]>([]);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping this remounts the widgets, so they re-read the world after a merge.
  const [generation, setGeneration] = useState(0);

  // The change itself and the list of components are cheap: no CLI calls behind either.
  useEffect(() => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    api<IntegrationInfo[]>("/integrations")
      .then(setInfos)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // Whether completing is allowed, refreshed alongside the widgets.
  useEffect(() => {
    if (change?.completedAt) return;
    let live = true;
    const load = () =>
      api<Completion>(`/changes/${id}/complete`)
        .then((c) => live && setCompletion(c))
        .catch(() => live && setCompletion(null));
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, change?.completedAt, generation]);

  const complete = () => {
    setCompleting(true);
    setError(null);
    post<Change>(`/changes/${id}/complete`, {})
      .then((updated) => {
        setChange(updated);
        setGeneration((g) => g + 1);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setCompleting(false));
  };

  return (
    <div className="page">
      <header>
        <button onClick={onBack}>← Changes</button>
        <h2>{id}</h2>
        {change && <span>branch {change.branch}</span>}
        {change?.jira && <span>{change.jira}</span>}
        <span className="spacer" />
        {change?.completedAt ? (
          <span className="badge ok">completed {change.completedAt.slice(0, 10)}</span>
        ) : (
          // The title sits on the wrapper: a disabled button fires no mouse events, so its own
          // tooltip would never appear. Every repository must be approved or already merged.
          <span title={completion?.reasons.join("\n") || undefined}>
            <button className="primary" disabled={completing || !completion?.ready} onClick={complete}>
              {completing ? "Completing…" : "Complete change"}
            </button>
          </span>
        )}
      </header>
      {error && <div className="error-banner">{error}</div>}
      {(provision ?? [])
        .filter((r) => !r.ok)
        .map((r) => (
          <div key={r.integration} className="error-banner">
            {r.integration}: {r.error}
          </div>
        ))}
      <div className="widgets">
        {infos.map((info) => (
          <WidgetCard key={`${info.name}-${generation}`} changeId={id} info={info} />
        ))}
      </div>
    </div>
  );
}
