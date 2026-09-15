import { type JSX, useEffect, useState } from "react";
import {
  api,
  patch,
  post,
  CHANGE_STATES,
  IDEATION,
  isIdeation,
  type ApiError,
  type ChangeState,
  type Change,
  type Cancelled,
  type Completed,
  type Completion,
  type CardInfo,
  type ProvisionResult,
} from "../../app-root/api.ts";
import { ActionsMenu, type Action } from "../../app-root/ActionsMenu.tsx";
import type { TerminalWindow } from "../../domain/terminal.ts";
import { useCached } from "../../app-root/cache.ts";
import { stateClass } from "../../app-root/stateClass.ts";
import { isFinished } from "../../domain/change.ts";
import { LifecycleFailures } from "../../app-root/LifecycleFailures.tsx";
import { TerminalPane } from "../../terminals/client/TerminalPane.tsx";
import { CheatSheet } from "../../terminals/client/CheatSheet.tsx";
import type { Platform } from "../../terminals/model.ts";
import { CompletionCard } from "../../dashboard/client/CompletionCard.tsx";
import { PerRepoCard } from "../../dashboard/client/PerRepoCard.tsx";
import { WidgetCard } from "../../dashboard/client/WidgetCard.tsx";
import { WindowTabs } from "../../terminals/client/WindowTabs.tsx";
import type { Page } from "../../app-root/Sidebar.tsx";
import { changeNav, resolveChangePage, type ChangeTabInfo } from "./changeTabs.ts";
import { PlanCard } from "./PlanCard.tsx";
import { TabHost, WidgetHost, type WidgetInfo } from "../../extension-host/client.tsx";

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
  /** Which page of the change to show: the core's dashboard or terminals, or a tab an
   * extension contributes. */
  page: Page;
  /** Results of the creation step, shown once: it is the one moment something can fail
   * without you having clicked it. */
  provision?: ProvisionResult[];
  /** The change's tmux session, owned by the app so the navigation column can list its
   * windows from any page. */
  terminal: {
    url: string | null;
    error: string | null;
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
   * views of the same change, not separate places. */
  onOpenPage: (page: Page) => void;
  /** The change was renamed, completed or otherwise altered: the lists elsewhere are stale. */
  onChanged: () => void;
  /** The server's platform: what the terminal's key hints and shortcut assume. */
  platform: Platform;
}): JSX.Element {
  const [change, setChange] = useCached<Change>(`${id}:change`);
  // Per change, not global: which components there are depends on the workspace it is in.
  const [infos, setInfos] = useCached<CardInfo[]>(`${id}:integrations`);
  // The tabs the change's page shows, per change for the same reason: they depend on the
  // workspace, and the server resolves that.
  const [tabs, setTabs] = useCached<ChangeTabInfo[]>(`${id}:tabs`);
  // The client-drawn widgets the dashboard shows, per change for the same reason.
  const [widgets, setWidgets] = useCached<WidgetInfo[]>(`${id}:widgets`);
  const [completion, setCompletion] = useCached<Completion>(`${id}:completion`);
  const [completing, setCompleting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The `change:completed`/`change:cancelled` observer failures of the operation just performed.
  // A successful observer reports nothing here, so it changes nothing visible.
  const [after, setAfter] = useState<ProvisionResult[]>([]);
  // The terminal keeps its shells whichever page you are on, so it is mounted once it has been
  // opened and only hidden afterwards.
  const [terminalOpened, setTerminalOpened] = useState(page === "terminals");
  const [cheatSheet, setCheatSheet] = useState(false);
  // Bumped when the cheat sheet closes: it is a modal dialog, so the browser moves the focus into it
  // and nothing puts it back (src/terminals/client/TerminalPane.tsx).
  const [focusRequest, setFocusRequest] = useState(0);
  // The change's name, while you are typing a new one. null when you are not.
  const [draft, setDraft] = useState<string | null>(null);
  // Bumping this remounts the widgets, so they re-read the world after a merge.
  const [generation, setGeneration] = useState(0);
  // Whether this change is still an idea: its state is set by creation and left by starting, so
  // the select shows the one word and the actions carry the transition.
  const idea = change ? isIdeation(change) : false;

  useEffect(() => {
    if (page === "terminals") setTerminalOpened(true);
  }, [page]);

  // The change itself and the list of components are cheap: no CLI calls behind either.
  useEffect(() => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    api<CardInfo[]>(`/changes/${id}/integrations`)
      .then(setInfos)
      .catch((e: Error) => setError(e.message));
    api<{ tabs: ChangeTabInfo[] }>(`/changes/${id}/tabs`)
      .then(({ tabs }) => setTabs(tabs))
      .catch((e: Error) => setError(e.message));
    api<{ widgets: WidgetInfo[] }>(`/changes/${id}/widgets`)
      .then(({ widgets }) => setWidgets(widgets))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // Whether completing is allowed, refreshed alongside the widgets.
  useEffect(() => {
    if (change?.completedAt) return;
    const ac = new AbortController();
    const load = (): Promise<void> =>
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

  const card = (info: CardInfo): JSX.Element =>
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
  const reload = (): void => {
    api<Change>(`/changes/${id}`)
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    setGeneration((g) => g + 1);
  };

  const copyDescription = (): Promise<void> =>
    api<{ text: string }>(`/changes/${id}/description`)
      .then(({ text }) => navigator.clipboard.writeText(text))
      .then(() => {
        setNotice("Pull request description copied");
        setTimeout(() => setNotice(null), 2500);
      })
      .catch((e: Error) => setError(e.message));

  const complete = (): void => {
    setCompleting(true);
    setError(null);
    post<Completed>(`/changes/${id}/complete`, {})
      .then(({ change: updated, after }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        setAfter(after);
      })
      // Where it stopped is in the completion card, which reads it from disk; this is only for
      // a refusal before anything started, such as a pull request that is not approved.
      .catch((e: Error) => setError(e.message))
      .finally(() => setCompleting(false));
  };

  /**
   * Start an idea's work: the state moves to In Progress, and the server's start hooks create
   * the checkouts and move the ticket. The terminal stays where it is — the change directory and
   * its pi session are unchanged, so the conversation continues.
   */
  const startWork = (): void => {
    setStarting(true);
    setError(null);
    post<{ change: Change; provision: ProvisionResult[] }>(`/changes/${id}/start`, {})
      .then(({ change: updated, provision }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        setAfter(provision);
        onChanged();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setStarting(false));
  };

  /**
   * Abandon the change: the worktrees and the terminal go, and everything anyone else can see —
   * branches, pull requests, the ticket — is left alone and listed back to you.
   */
  const cancel = (force = false): void => {
    if (
      !force &&
      !window.confirm(
        idea
          ? `Discard ${id}? It is archived as cancelled. Nothing was created for it.`
          : `Cancel ${id}? The worktrees and the terminal go. The branches, pull requests and the ` +
              `ticket are left alone — you will be told what is left.`,
      )
    ) {
      return;
    }
    setCancelling(true);
    setError(null);
    post<Cancelled>(`/changes/${id}/cancel`, { force })
      .then(({ change: updated, loose, after }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        onChanged();
        setAfter(after);
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

  // Renaming sits in the menu rather than on the name itself: the row the name is in is the
  // window's title bar in the app, and a button there would be a hole in the region you drag the
  // window by (docs/decisions/window-titlebar.md).
  const rename: Action = {
    label: "Rename change",
    title: "A name of your own; the ticket's summary is only a suggestion",
    onSelect: () => setDraft(change?.title ?? ""),
  };

  // The two ways a change ends are last, and apart: everything above them is reversible. An idea
  // has a third: starting the work, which is the only way out of `Ideation` and the reason it is
  // an action rather than one of the select's words.
  const changeActions: Action[] = [
    rename,
    ...(idea
      ? [
          {
            label: starting ? "Starting…" : "Start work",
            disabled: starting,
            title: "Leave Ideation: create the worktrees and move the ticket",
            onSelect: startWork,
          },
          {
            label: cancelling ? "Discarding…" : "Discard idea",
            separated: true,
            disabled: cancelling || starting,
            title: "Archive this idea as cancelled; nothing was created",
            onSelect: () => cancel(),
          },
        ]
      : [
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
        ]),
  ];

  // The nav the page shows, and which of its tabs is current. A URL naming an id nobody offers
  // — a tab that has gone, a typo — resolves to the dashboard, so the page still renders.
  const nav = changeNav(tabs ?? []);
  const active = resolveChangePage(page, tabs ?? []);
  const activeId = active.kind === "tab" ? active.tab.id : active.kind;

  const windowTabs = (
    <WindowTabs
      // Which surface is on screen, not which of the change's tabs: this row is the change's views
      // against its terminals, and the row below says which of those views. An unknown segment
      // resolves to the dashboard, which is one of them.
      page={active.kind}
      windows={windows}
      platform={platform}
      onSelectWindow={onSelectWindow}
      onNewWindow={onNewWindow}
      onMoveWindow={onMoveWindow}
      onOpenPage={onOpenPage}
    />
  );

  /** The window's own row: the change's terminals as tabs, and — on the terminal page — the key
   * reference. The change's name is deliberately not here: the navigation column carries it, and the
   * row is the window's, so both of a change's pages still begin the same way
   * (docs/decisions/window-titlebar.md). */
  const changeHeader = (
    <header className="change-bar">
      {windowTabs}
      <span className="spacer" />
      {/* The key reference is the terminal's: on the dashboard the row below carries the change's
          own tabs, state and actions instead. */}
      {active.kind === "terminals" && (
        <button onClick={() => setCheatSheet(true)}>tmux cheat sheet</button>
      )}
    </header>
  );

  return (
    <div className={active.kind === "terminals" ? "page terminal-page" : "page"}>
      {/* The window's title bar: the change's name, a tab per terminal, and — on the terminal page
          — the key reference. The same row on both of a change's pages. */}
      {changeHeader}
      <CheatSheet
        changeId={id}
        open={cheatSheet}
        onClose={() => {
          setCheatSheet(false);
          setFocusRequest((n) => n + 1);
        }}
        platform={platform}
      />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {/* Creation's observer failures, shown once where the create was started. */}
      <LifecycleFailures results={provision} />
      {/* A completed or cancelled change's observer failures: the operation itself succeeded, so
          these are reported on its response rather than rendered as a failure of the change. */}
      <LifecycleFailures results={after} />
      {/* Unmounted rather than hidden while you are in the terminal: their per-repository CLI
          calls hold every connection the browser allows per origin for seconds at a time, and
          the terminal's own polling would queue behind them. Coming back repaints from the
          cache and refreshes. */}
      {/* The change's own views, and the change's state and actions at the tabs' height: they belong
          to the change rather than to any one of its views, and the row that says which view you are
          in is where they fit — under the window's row rather than in it. */}
      {active.kind !== "terminals" && (
        <div className="change-tabs">
          <nav className="tabs">
            {nav.map((tab) => (
              <button
                key={tab.id}
                className={activeId === tab.id ? "tab current" : "tab"}
                onClick={() => onOpenPage(tab.id)}
              >
                {tab.title}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          {change && (
            <>
              {/* The name is typed here, in the row the menu that asks for it lives in: the window's
                  own row says nothing about the change (docs/decisions/window-titlebar.md). */}
              {draft !== null && (
                <input
                  className="subject"
                  autoFocus
                  value={draft}
                  placeholder="what this change is about"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setDraft(null);
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={() => {
                    const next = draft.trim();
                    setDraft(null);
                    if (next === (change.title ?? "")) return;
                    // A name the ticket suggested is not a fact: renaming it stops it being
                    // refreshed from Jira, and clearing it hands the name back.
                    patch<Change>(`/changes/${id}`, { title: next })
                      .then((updated) => {
                        setChange(updated);
                        onChanged();
                      })
                      .catch((err: Error) => setError(err.message));
                  }}
                />
              )}
              <select
                className={stateClass(change.state)}
                value={change.state ?? "In Progress"}
                // An idea's state is not yours to pick: starting the work is what leaves it, and
                // that does more than a word (see the actions).
                disabled={idea}
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
                {/* An idea shows its one state. A started change offers the states you are in, not
                    the ones a change ends in, and not `Ideation` — there is no going back over a
                    branch that now exists. Picking "Completed" from a list would set the word
                    without merging anything, removing a worktree or archiving the change — a label
                    that lies. Ending a change is Complete or Cancel, which do the work. A change
                    that has already ended still shows its own state, because a select cannot
                    display what it does not offer. */}
                {idea ? (
                  <option>{IDEATION}</option>
                ) : (
                  <>
                    {CHANGE_STATES.filter(
                      (s) => !isFinished({ ...change, state: s }) && s !== IDEATION,
                    ).map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                    {isFinished(change) && <option>{change.state}</option>}
                  </>
                )}
              </select>
              {isFinished(change) ? (
                // How it ended, not only that it did: a change that was abandoned is not one that
                // landed, and the badge is the only place that says so on this page.
                <span
                  className={`badge ${change.state === "Cancelled" ? stateClass(change.state) : "ok"}`}
                >
                  {(change.state ?? "Completed").toLowerCase()} {change.completedAt?.slice(0, 10)}
                </span>
              ) : (
                <ActionsMenu actions={changeActions} />
              )}
            </>
          )}
        </div>
      )}
      {active.kind === "dashboard" && (
        <div className="widgets">
          {/* The left column is the change's documents: the plan and any widget that declares
              itself one. The right holds the status — completion, the cards, the other widgets —
              every card the full width of its column. An empty side is dropped rather than
              given half the window by the grid. */}
          <div className="column documents">
            {/* The plan is the change's own document: it stays visible once the work starts, and
                is a read-only record once the change is over. */}
            {change && (
              <PlanCard changeId={id} canBrief={idea} readOnly={isFinished(change)} />
            )}
            {(infos ?? []).filter((i) => i.column === "left").map(card)}
            {/* Client-drawn documents, after the plan: textareas and other client state a polled
                card cannot hold. Deliberately not keyed by generation — a remount after a merge
                would drop in-flight typing. Nothing to hand a widget before the change loads,
                so they wait for it; the cards do not. */}
            {change &&
              (widgets ?? [])
                .filter((w) => w.column === "left")
                .map((w) => (
                  <WidgetHost
                    key={`${w.extension}:${w.id}`}
                    info={w}
                    change={change}
                    workspace={change.workspace}
                  />
                ))}
          </div>
          <div className="column status">
            <CompletionCard changeId={id} busy={completing} onFinished={setChange} />
            {(infos ?? []).filter((i) => i.column !== "left").map(card)}
            {change &&
              (widgets ?? [])
                .filter((w) => w.column !== "left")
                .map((w) => (
                  <WidgetHost
                    key={`${w.extension}:${w.id}`}
                    info={w}
                    change={change}
                    workspace={change.workspace}
                  />
                ))}
          </div>
        </div>
      )}
      {/* An extension's own tab. It gets the change, which may still be loading: nothing to
          hand it means a hint rather than a crash. */}
      {active.kind === "tab" &&
        (change ? (
          <TabHost
            key={active.tab.id}
            info={active.tab}
            change={change}
            workspace={change.workspace}
          />
        ) : (
          <p className="hint">loading…</p>
        ))}
      {terminalOpened && (
        <div className="terminal-host" hidden={active.kind !== "terminals"}>
          <TerminalPane
            changeId={id}
            url={terminal.url}
            error={terminal.error}
            visible={active.kind === "terminals"}
            focusRequest={focusRequest}
            platform={platform}
            onNewWindow={terminal.create}
            windows={windows.length}
          />
        </div>
      )}
    </div>
  );
}
