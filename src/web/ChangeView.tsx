import { useCallback, useEffect, useRef, useState } from "react";
import {
  aborted,
  api,
  patch,
  post,
  CHANGE_STATES,
  type ChangeState,
  type Change,
  type Completion,
  type IntegrationInfo,
  type ProvisionResult,
  type RepoItems,
  type Widget,
  type WidgetItem,
} from "./api.ts";
import { ActionsMenu, type Action } from "./ActionsMenu.tsx";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { cached, putCached, useCached } from "./cache.ts";
import { stateClass } from "./changeState.tsx";
import { EditReposDialog } from "./EditReposDialog.tsx";
import { NotesCard } from "./NotesCard.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { type TerminalWindow } from "./WindowStrip.tsx";
import { CheatSheet } from "./CheatSheet.tsx";
import { CompletionCard } from "./CompletionCard.tsx";
import { LocalPane } from "./LocalPane.tsx";
import { busyWindows } from "../windows.ts";

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
        {item.menu?.length ? (
          <ActionsMenu
            className="dots"
            label="⋯"
            actions={item.menu.map((a) => ({
              label: a.label,
              disabled: busy,
              onSelect: () => {
                if (!a.confirm || window.confirm(a.confirm)) onAction(a.id, a.arg);
              },
            }))}
          />
        ) : null}
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

const worstOf = (items: WidgetItem[]): string =>
  ["error", "pending", "warn", "ok"].find((s) => items.some((i) => i.state === s)) ?? "none";

const nameOf = (repo: string): string => repo.split("/").pop() ?? repo;

/** Branch names start with the change id, which the crumb already shows: drop the repetition. */
const branchLabel = (id: string, branch: string): string =>
  branch.startsWith(`${id}-`) ? branch.slice(id.length + 1) : branch;

/**
 * A card whose rows come from a per-repository component: every repository is fetched on its own,
 * so they appear one by one instead of the card staying empty until the slowest one answers.
 */
function PerRepoCard({
  changeId,
  info,
  repos,
  onReposChanged,
}: {
  changeId: string;
  info: IntegrationInfo;
  repos: string[];
  onReposChanged: () => void;
}) {
  const key = (repo: string) => `${changeId}:${info.name}:${repo}`;
  // undefined while that repository is still loading; seeded from the cache so coming back to a
  // change shows its last known rows immediately.
  const [items, setItems] = useState<Record<string, WidgetItem[] | undefined>>(() =>
    Object.fromEntries(repos.map((repo) => [repo, cached<WidgetItem[]>(key(repo))])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const loadRepo = useCallback(
    (repo: string, signal?: AbortSignal): Promise<void> =>
      api<RepoItems>(`/changes/${changeId}/${info.name}/repo?path=${encodeURIComponent(repo)}`, {
        signal,
      })
        .then((r) => {
          putCached(key(repo), r.items);
          setItems((all) => ({ ...all, [repo]: r.items }));
        })
        .catch((e: Error) => {
          if (aborted(e)) return;
          setItems((all) => ({
            ...all,
            [repo]: [{ label: nameOf(repo), detail: e.message, state: "error" }],
          }));
        }),
    [changeId, info.name],
  );

  useEffect(() => {
    // Cancel on unmount: these requests are slow, and the browser only allows six at a time, so
    // leaving them open makes the next page wait seconds for a free connection.
    const ac = new AbortController();
    const tick = () => repos.forEach((repo) => void loadRepo(repo, ac.signal));
    tick();
    const timer = setInterval(tick, 15000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [loadRepo, repos.join(",")]);

  const act = (repo: string, actionId: string, arg?: string): Promise<void> => {
    setBusy(repo);
    return post<RepoItems>(`/changes/${changeId}/${info.name}/${actionId}`, { arg })
      .then((r) => {
        putCached(key(repo), r.items);
        setItems((all) => ({ ...all, [repo]: r.items }));
      })
      .catch((e: Error) =>
        setItems((all) => ({
          ...all,
          [repo]: [{ label: nameOf(repo), detail: e.message, state: "error" }],
        })),
      )
      .finally(() => setBusy(null));
  };

  const loaded = repos.filter((r) => items[r]);
  const all = loaded.flatMap((r) => items[r]!);
  return (
    <section className={`widget ${loaded.length === repos.length ? "" : "loading"}`}>
      <h3>
        <Dot state={loaded.length ? worstOf(all) : undefined} />
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
      {/* No summary once everything is in: the rows already say it. */}
      {loaded.length < repos.length && (
        <div className="summary">{`${loaded.length}/${repos.length} repositories loaded…`}</div>
      )}
      {repos.map((repo) =>
        items[repo] ? (
          items[repo]!.map((item) => (
            <Item
              key={item.label}
              item={item}
              busy={busy === repo}
              onAction={(actionId, arg) => act(repo, actionId, arg)}
            />
          ))
        ) : (
          <div key={repo} className="item depth-0 pending-row">
            <span className="toggle-spacer" />
            <Dot />
            <span className="label">{nameOf(repo)}</span>
            <span className="detail">loading…</span>
          </div>
        ),
      )}
      {info.name === "git" && (
        <EditReposDialog
          changeId={changeId}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={onReposChanged}
        />
      )}
    </section>
  );
}

/** One card, loading and refreshing itself: a slow CLI delays its own widget and nothing else. */
function WidgetCard({ changeId, info }: { changeId: string; info: IntegrationInfo }) {
  const [widget, setWidget] = useCached<Widget>(`${changeId}:${info.name}`);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal): Promise<void> =>
      api<Widget>(`/changes/${changeId}/${info.name}`, { signal })
        .then(setWidget)
        .catch((e: Error) => {
          if (aborted(e)) return;
          setWidget({
            integration: info.name,
            title: info.title,
            state: "error",
            summary: e.message,
            items: [],
          });
        }),
    [changeId, info.name, info.title],
  );

  useEffect(() => {
    const ac = new AbortController();
    const tick = () => void load(ac.signal);
    tick();
    const timer = setInterval(tick, 15000);
    return () => {
      ac.abort();
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
      </h3>
      {/* The summary is only worth the line while loading, or when it carries an error. */}
      {(!widget || widget.state === "error") && (
        <div className="summary">{widget ? widget.summary : "loading…"}</div>
      )}
      {(widget?.items ?? []).map((item) => (
        <Item key={item.label} item={item} busy={busy} onAction={act} />
      ))}
    </section>
  );
}

export function ChangeView({
  id,
  provision,
  onHome,
}: {
  id: string;
  /** Results of the creation step, shown once: it is the one moment something can fail
   * without you having clicked it. */
  provision?: ProvisionResult[];
  onHome: () => void;
}) {
  const [change, setChange] = useCached<Change>(`${id}:change`);
  const [infos, setInfos] = useCached<IntegrationInfo[]>("integrations");
  const [completion, setCompletion] = useCached<Completion>(`${id}:completion`);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The terminal keeps its shells whichever tab you are on, so it is mounted once the tab has
  // been opened and only hidden afterwards.
  const [tab, setTab] = useState<"dashboard" | "terminals" | "local">("dashboard");
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [terminal, setTerminal] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [cheatSheet, setCheatSheet] = useState(false);
  const [windows, setWindows] = useState<TerminalWindow[]>([]);
  // Windows running something rather than sitting at a prompt, counted the way the overview
  // counts them, so the tab and the card cannot disagree.
  const busy = busyWindows(windows);
  // Bumping this remounts the widgets, so they re-read the world after a merge.
  const [generation, setGeneration] = useState(0);

  // Asked for on arrival, not when the Terminals tab is clicked: by then the widgets have all
  // six connections the browser allows per origin busy with slow CLI calls, and the terminal
  // would wait its turn. Starting ttyd here means the tab is ready the moment it is opened.
  useEffect(() => {
    setTerminal(null);
    if (change?.completedAt) return; // archived: there is nothing left to attach to
    api<{ url: string }>(`/changes/${id}/terminal`)
      .then(({ url }) => setTerminal(url))
      .catch((e: Error) => setTerminalError(e.message));
  }, [id]);

  // The windows of the terminal, for the strip and for the count on the tab. Slowly while you
  // are on the dashboard: it is one number there, and the dashboard's own calls are slow enough
  // to queue behind.
  useEffect(() => {
    if (change?.completedAt) return setWindows([]);
    const load = () =>
      api<TerminalWindow[]>(`/changes/${id}/terminal/windows`)
        .then(setWindows)
        .catch(() => {}); // no session yet: the next tick will find it
    void load();
    const timer = setInterval(load, tab === "terminals" ? 1500 : 10_000);
    return () => clearInterval(timer);
  }, [id, tab, change?.completedAt]);

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
    const ac = new AbortController();
    const load = () =>
      api<Completion>(`/changes/${id}/complete`, { signal: ac.signal })
        .then(setCompletion)
        .catch(() => {}); // keep the last verdict rather than blanking the button
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [id, change?.completedAt, generation]);

  const card = (info: IntegrationInfo) =>
    info.perRepo ? (
      <PerRepoCard
        key={`${info.name}-${generation}`}
        changeId={id}
        info={info}
        repos={change?.repos ?? []}
        onReposChanged={reload}
      />
    ) : (
      <WidgetCard key={`${info.name}-${generation}`} changeId={id} info={info} />
    );

  // Re-read the change and remount the cards: its repository list just changed.
  const reload = () => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    setGeneration((g) => g + 1);
  };

  const copyDescription = () =>
    api<{ text: string }>(`/changes/${id}/description`)
      .then(({ text }) => navigator.clipboard.writeText(text))
      .then(() => {
        setNotice("Pull request description copied");
        setTimeout(() => setNotice(null), 2500);
      })
      .catch((e: Error) => setError(e.message));

  const complete = () => {
    setCompleting(true);
    setError(null);
    post<{ change: Change; notes: string[] }>(`/changes/${id}/complete`, {})
      .then(({ change: updated }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
      })
      // Where it stopped is in the completion card, which reads it from disk; this is only for
      // a refusal before anything started, such as a pull request that is not approved.
      .catch((e: Error) => setError(e.message))
      .finally(() => setCompleting(false));
  };

  // Completing is last: it is the irreversible one.
  const changeActions: Action[] = [
    { label: "Copy PR description", onSelect: copyDescription },
    {
      label: completing ? "Completing…" : "Complete change",
      separated: true,
      disabled: completing || !completion?.ready,
      // Every repository must be approved or already merged.
      title: completion?.reasons.join("\n") || undefined,
      onSelect: complete,
    },
  ];

  return (
    <div className="page">
      <header>
        <Breadcrumb trail={[change ? `${id} - ${branchLabel(id, change.branch)}` : id]} onHome={onHome} />
        <span className="spacer" />
        {change && (
          <select
            className={stateClass(change.state)}
            value={change.state ?? "In Progress"}
            // Your own view of where the change stands; completing it sets "Completed".
            onChange={(e) =>
              patch<Change>(`/changes/${id}`, { state: e.target.value as ChangeState })
                .then(setChange)
                .catch((err: Error) => setError(err.message))
            }
          >
            {CHANGE_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        {change?.completedAt ? (
          <span className="badge ok">completed {change.completedAt.slice(0, 10)}</span>
        ) : (
          <ActionsMenu actions={changeActions} />
        )}
      </header>
      <nav className="tabs">
        {(["dashboard", "terminals", "local"] as const).map((name) => (
          <button
            key={name}
            className={tab === name ? "tab current" : "tab"}
            onClick={() => {
              setTab(name);
              if (name === "terminals") setTerminalOpened(true);
            }}
          >
            {name === "dashboard" ? (
              "Dashboard"
            ) : name === "local" ? (
              "Local changes"
            ) : (
              <>
                Terminals
                {/* What the terminals are doing, in the same words the overview uses: a build
                    running is worth seeing from another tab. */}
                {windows.length > 0 && (
                  <span className="state">
                    <span className={`dot ${busy > 0 ? "ok" : "none"}`} />
                    {busy > 0 ? `${busy} active` : "idle"}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
        <span className="spacer" />
        {/* Only where it means something: tmux keys are no help on the dashboard. */}
        {tab === "terminals" && (
          <button className="tab" onClick={() => setCheatSheet(true)}>
            tmux cheat sheet
          </button>
        )}
      </nav>
      <CheatSheet changeId={id} open={cheatSheet} onClose={() => setCheatSheet(false)} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {(provision ?? [])
        .filter((r) => !r.ok)
        .map((r) => (
          <div key={r.integration} className="error-banner">
            {r.integration}: {r.error}
          </div>
        ))}
      {/* Unmounted rather than hidden while you are in the terminal: their per-repository CLI
          calls hold every connection the browser allows per origin for seconds at a time, and
          the terminal's own polling would queue behind them. Coming back repaints from the
          cache and refreshes. */}
      {tab === "dashboard" && (
        <div className="widgets">
          <div className="column">
            <CompletionCard changeId={id} busy={completing} onFinished={setChange} />
            {(infos ?? []).filter((i) => !i.wide).map(card)}
            <NotesCard changeId={id} />
          </div>
          <div className="column">{(infos ?? []).filter((i) => i.wide).map(card)}</div>
        </div>
      )}
      {/* Every repository in one list: a change is the unit of work, not a checkout. */}
      {tab === "local" && <LocalPane changeId={id} repos={change?.repos ?? []} />}
      {terminalOpened && (
        <div hidden={tab !== "terminals"}>
          <TerminalPane
            changeId={id}
            url={terminal}
            error={terminalError}
            visible={tab === "terminals"}
            windows={windows}
            onWindowsChanged={setWindows}
          />
        </div>
      )}
    </div>
  );
}

