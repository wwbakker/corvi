import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  aborted,
  api,
  patch,
  post,
  CHANGE_STATES,
  type ApiError,
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
import { AgentIcon, TerminalIcon } from "./icons.tsx";
import type { TerminalWindow } from "../terminalTypes.ts";
import { cached, putCached, useCached } from "./cache.ts";
import { stateClass } from "./changeState.tsx";
import { isFinished } from "../types.ts";
import { EditReposDialog } from "./EditReposDialog.tsx";
import { NotesCard } from "./NotesCard.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { CheatSheet } from "./CheatSheet.tsx";
import type { Platform } from "./newWindowKey.ts";
import { CompletionCard } from "./CompletionCard.tsx";
import { LocalPane } from "./LocalPane.tsx";
import { Progress } from "./Progress.tsx";

function Dot({ state }: { state?: string }) {
  return <span className={`dot ${state ?? "none"}`} />;
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
  page,
  platform,
  provision,
  terminal,
  windows,
  onSelectWindow,
  onNewWindow,
  onMoveWindow,
  onOpenPage,
  onChanged,
}: {
  id: string;
  /** Which page of the change to show. */
  page: "dashboard" | "review" | "terminals";
  /** Results of the creation step, shown once: it is the one moment something can fail
   * without you having clicked it. */
  provision?: ProvisionResult[];
  /** The change's tmux session, owned by the app so the navigation column can list its
   * windows from any page. */
  terminal: {
    url: string | null;
    error: string | null;
    /** The ttyd on record has outlived its tmux session: the shells are gone. */
    gone: boolean;
    /** That ttyd's pid, for the message that says how to start over. */
    pid?: number;
    create: () => void;
  };
  /** This change's tmux windows: what the terminal page's tabs are. */
  windows: TerminalWindow[];
  /** Switching the session to one of its windows. */
  onSelectWindow: (index: number) => void;
  /** Another window beside the current one. The terminal's own chord does this from inside it;
   * this is the tab that does. */
  onNewWindow: () => void;
  /** A dragged tab landed: the window at `from` takes the place of the one at `to`. */
  onMoveWindow: (from: number, to: number) => void;
  /** Switching between the change's own pages, which are tabs rather than navigation: they are
   * two views of the same change, not two places. */
  onOpenPage: (page: "dashboard" | "review") => void;
  /** The change was renamed, completed or otherwise altered: the lists elsewhere are stale. */
  onChanged: () => void;
  /** The server's platform: what the terminal's key hints and shortcut assume. */
  platform: Platform;
}) {
  const [change, setChange] = useCached<Change>(`${id}:change`);
  // Per change, not global: which components there are depends on the workspace it is in.
  const [infos, setInfos] = useCached<IntegrationInfo[]>(`${id}:integrations`);
  const [completion, setCompletion] = useCached<Completion>(`${id}:completion`);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The terminal keeps its shells whichever page you are on, so it is mounted once it has been
  // opened and only hidden afterwards.
  const [terminalOpened, setTerminalOpened] = useState(page === "terminals");
  const [cheatSheet, setCheatSheet] = useState(false);
  // Which window tab a drag is carrying, and which one it is over: the fixed ends of the strip
  // — overview and "new" — take no part in either.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The change's name, while you are typing a new one. null when you are not.
  const [draft, setDraft] = useState<string | null>(null);
  // Bumping this remounts the widgets, so they re-read the world after a merge.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (page === "terminals") setTerminalOpened(true);
  }, [page]);

  // The change itself and the list of components are cheap: no CLI calls behind either.
  useEffect(() => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    api<IntegrationInfo[]>(`/changes/${id}/integrations`)
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

  /**
   * Abandon the change: the worktrees and the terminal go, and everything anyone else can see —
   * branches, pull requests, the ticket — is left alone and listed back to you.
   */
  const cancel = (force = false) => {
    if (
      !force &&
      !window.confirm(
        `Cancel ${id}? The worktrees and the terminal go. The branches, pull requests and the ` +
          `ticket are left alone — you will be told what is left.`,
      )
    ) {
      return;
    }
    setCancelling(true);
    setError(null);
    post<{ change: Change; loose: string[] }>(`/changes/${id}/cancel`, { force })
      .then(({ change: updated, loose }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        onChanged();
        if (loose.length) setNotice(`Cancelled. Still open: ${loose.join("; ")}`);
      })
      .catch((e: ApiError) => {
        const needsForce = (e.body as { needsForce?: string[] })?.needsForce;
        // Commits nobody else has. The branch survives, so this is recoverable — by someone who
        // knows the branch is there, which is worth one question.
        if (needsForce?.length) {
          if (
            window.confirm(
              `${needsForce.join(", ")}: commits that were never pushed. ` +
                `The worktree goes, the branch is kept. Cancel anyway?`,
            )
          ) {
            cancel(true);
          }
          return;
        }
        setError(e.message);
      })
      .finally(() => setCancelling(false));
  };

  // The two ways a change ends are last, and apart: everything above them is reversible.
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
    {
      label: cancelling ? "Cancelling…" : "Cancel change",
      disabled: cancelling || completing,
      title: "Abandon this change: the worktrees go, nothing is merged",
      onSelect: () => cancel(),
    },
  ];

  /** The change's windows as tabs, with the way back to the dashboard first. The dashboard and
   * the terminal both show this strip — a window is one click from either — and because it is
   * one element, the contents are the same on both: the same icon in the same colour, the same
   * name. */
  const startDrag = (e: ReactMouseEvent<HTMLButtonElement>, from: number): void => {
    // The drag needs the mousedown that keeps the keyboard in the terminal after a plain click,
    // so it is tracked by hand: mousedown, the window's mouse moves, mouseup. HTML5 drag events
    // would not start at all once the default is prevented.
    e.preventDefault();
    if (e.button !== 0) return;
    const strip = e.currentTarget.closest(".window-tabs");
    if (!strip) return;
    const under = (x: number, y: number): number | null => {
      for (const tab of strip.querySelectorAll<HTMLElement>("[data-window-index]")) {
        const box = tab.getBoundingClientRect();
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
          return Number(tab.dataset.windowIndex);
        }
      }
      return null;
    };
    const startedAt = e.clientX;
    let dragging = false;
    const move = (ev: MouseEvent) => {
      // A few pixels of travel: a click that wobbles is still a click.
      if (!dragging && Math.abs(ev.clientX - startedAt) < 4) return;
      dragging = true;
      setDragIndex(from);
      setDropIndex(under(ev.clientX, ev.clientY));
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragIndex(null);
      setDropIndex(null);
      const to = dragging ? under(ev.clientX, ev.clientY) : null;
      if (to !== null && to !== from) onMoveWindow(from, to);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const windowTabs = (
    <nav className="window-tabs">
      {/* The way back to what the change is doing. On the dashboard the tab is already where
          you are; in the terminal it is the way out. */}
      <button
        className={page === "dashboard" ? "window-tab overview current" : "window-tab overview"}
        title="the change's overview"
        onClick={() => onOpenPage("dashboard")}
      >
        <span className="label">Overview</span>
      </button>
      {windows.map((w) => {
        const classes = ["window-tab"];
        if (w.active && page === "terminals") classes.push("current");
        if (dragIndex === w.index) classes.push("dragging");
        if (dropIndex === w.index && dragIndex !== null && dragIndex !== w.index) {
          classes.push("drop-target");
        }
        return (
          <button
            key={w.index}
            data-window-index={w.index}
            className={classes.join(" ")}
            title={`ctrl-b ${w.index} — ${w.detail}`}
            // Focus is what a mousedown moves, and a terminal you cannot type in after clicking
            // a tab is useless; the drag rides the same mousedown (see startDrag).
            onMouseDown={(e) => startDrag(e, w.index)}
            onClick={() => onSelectWindow(w.index)}
          >
            <span className={w.state === "ok" ? "state-ok" : "state-idle"}>
              {w.icon === "agent" ? <AgentIcon title={w.label} /> : <TerminalIcon title={w.label} />}
            </span>
            <span className="label">{w.label}</span>
            {/* Not for the window you are looking at: you see its output already. */}
            {w.activity && !(w.active && page === "terminals") && (
              <span className="bell" title="new output" />
            )}
          </button>
        );
      })}
      {/* A session that has not started yet has nothing to add a window to; opening the
          terminal starts it, with the first window. */}
      <button
        className="window-tab new"
        title={
          platform === "mac"
            ? "new terminal here (cmd-t, or ctrl-b c)"
            : "new terminal here (ctrl-alt-t, or ctrl-b c)"
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNewWindow}
      >
        <TerminalIcon title="new terminal" />
        <span className="label">new</span>
      </button>
    </nav>
  );

  /** The terminal page's own bar: the windows, and the key reference. The change's id, name,
   * state and actions are the dashboard's — while a shell has the keyboard they say nothing. */
  const terminalBar = (
    <header className="terminal-bar">
      {windowTabs}
      <span className="spacer" />
      <button onClick={() => setCheatSheet(true)}>tmux cheat sheet</button>
    </header>
  );

  const changeBar = (
    <header>
      {/* The one heading: where you are is in the navigation column, so this says what the
          change is rather than how you got here. */}
      <h2>
        {id}
        {change &&
          (draft === null ? (
            // A name that came from the ticket is a suggestion, not a fact: rename it here and
            // it stops being refreshed from Jira. Clearing it hands it back.
            <button
              className="subject"
              title="rename this change"
              onClick={() => setDraft(change.title ?? "")}
            >
              {change.title ?? branchLabel(id, change.branch)}
            </button>
          ) : (
            <input
              className="subject"
              autoFocus
              value={draft}
              placeholder={change.jira ? `from ${change.jira}` : "what this change is about"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={() => {
                const next = draft.trim();
                setDraft(null);
                if (next === (change.title ?? "")) return;
                patch<Change>(`/changes/${id}`, { title: next })
                  .then((updated) => {
                    setChange(updated);
                    onChanged();
                  })
                  .catch((err: Error) => setError(err.message));
              }}
            />
          ))}
      </h2>
      <span className="spacer" />
      {change && (
        <select
          className={stateClass(change.state)}
          value={change.state ?? "In Progress"}
          // Your own view of where the change stands; completing it sets "Completed".
          onChange={(e) =>
            patch<Change>(`/changes/${id}`, { state: e.target.value as ChangeState })
              .then((updated) => {
                setChange(updated);
                onChanged(); // the navigation column and the overview list states too
              })
              .catch((err: Error) => setError(err.message))
          }
        >
          {/* Only the states you are in, not the ones a change ends in: picking "Completed"
              from a list used to set the word without merging anything, removing a worktree or
              archiving the change — a label that lies. Ending a change is Complete or Cancel,
              which do the work. A change that has already ended still shows its own state,
              because a select cannot display what it does not offer. */}
          {CHANGE_STATES.filter((s) => !isFinished({ ...change, state: s })).map((s) => (
            <option key={s}>{s}</option>
          ))}
          {isFinished(change) && <option>{change.state}</option>}
        </select>
      )}
      {change && isFinished(change) ? (
        // How it ended, not only that it did: a change that was abandoned is not one that
        // landed, and the badge is the only place that says so on this page.
        <span className={`badge ${change.state === "Cancelled" ? stateClass(change.state) : "ok"}`}>
          {(change.state ?? "Completed").toLowerCase()} {change.completedAt?.slice(0, 10)}
        </span>
      ) : (
        <ActionsMenu actions={changeActions} />
      )}
    </header>
  );

  return (
    <div className={page === "terminals" ? "page terminal-page" : "page"}>
      {/* The same strip at the very top of the dashboard too, above the change's header, so a
          terminal window is one click from where the work is. */}
      {page === "dashboard" && <div className="window-bar">{windowTabs}</div>}
      {page === "terminals" ? terminalBar : changeBar}
      <CheatSheet changeId={id} open={cheatSheet} onClose={() => setCheatSheet(false)} platform={platform} />
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
      {/* Two views of one change: what it is doing, and what is in it. The terminal is not one
          of them — it is reached from the navigation column, and lives in its own page. */}
      {page !== "terminals" && (
        <nav className="tabs">
          {([
            ["dashboard", "Dashboard"],
            ["review", "Review changes"],
          ] as const).map(([name, label]) => (
            <button
              key={name}
              className={page === name ? "tab current" : "tab"}
              onClick={() => onOpenPage(name)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {page === "dashboard" && (
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
      {page === "review" && (
        <LocalPane
          changeId={id}
          repos={change?.repos ?? []}
          // What people write anyway, so it is there to edit rather than to type.
          suggestion={change?.title ? `${id} ${change.title}` : id}
        />
      )}
      {terminalOpened && (
        <div className="terminal-host" hidden={page !== "terminals"}>
          <TerminalPane
            changeId={id}
            url={terminal.url}
            error={terminal.error}
            visible={page === "terminals"}
            platform={platform}
            onNewWindow={terminal.create}
            gone={terminal.gone}
            pid={terminal.pid}
            windows={windows.length}
          />
        </div>
      )}
    </div>
  );
}

