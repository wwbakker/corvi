import { type JSX, useEffect, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import {
  apiClient,
  isIdeation,
  type ChangeState,
  type Change,
  type Completion,
  type CompletionRefusal,
  type CardInfo,
  type ProvisionResult,
} from "../../app-root/api.ts";
import type { TerminalWindow } from "../../domain/terminal.ts";
import { useCached } from "../../app-root/cache.ts";
import { FORMAT_VERSION, isFinished } from "../../domain/change.ts";
import { LifecycleFailures } from "../../app-root/LifecycleFailures.tsx";
import { TerminalPane } from "../../terminals/client/TerminalPane.tsx";
import { CheatSheet } from "../../terminals/client/CheatSheet.tsx";
import type { Platform } from "@corvi/terminals/model";
import { CompleteAnywayDialog } from "./CompleteAnywayDialog.tsx";
import { CancelDialog } from "./CancelDialog.tsx";
import { cancelNeedsForce, completionRefusal } from "./refusals.ts";
import { WindowTabs } from "../../terminals/client/WindowTabs.tsx";
import type { Page } from "../../app-root/Sidebar.tsx";
import { changeNav, resolveChangePage, type ChangeTabInfo } from "./changeTabs.ts";
import { forgetChange, lastViewOf, seeView } from "../../app-root/remember.ts";
import { changeActions } from "./changeActions.ts";
import { ChangeControls } from "./ChangeControls.tsx";
import { ChangeDashboard } from "./ChangeDashboard.tsx";
import { PlanPage } from "./PlanPage.tsx";
import { TabHost, type WidgetInfo } from "../../integrations/client.tsx";

/** The message to show for whatever a request threw: typed client errors and plain errors both
 * carry one. */
const failureMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One change's page: the window's row and the change's own controls above one of its views —
 * the dashboard, its plan, an extension's tab, or its terminals. This is the composer: what the
 * views are made of lives in `ChangeControls`, `ChangeDashboard` and `PlanPage`, and the two
 * ways a change ends are `CompleteAnywayDialog` and `CancelDialog`, asked for before anything
 * runs.
 */
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
  // and nothing puts it back (apps/web/src/terminals/client/TerminalPane.tsx).
  const [focusRequest, setFocusRequest] = useState(0);
  // The change's name, while you are typing a new one. null when you are not.
  const [draft, setDraft] = useState<string | null>(null);
  // Bumping this remounts the dashboard's cards, so they re-read the world after a merge.
  const [generation, setGeneration] = useState(0);
  // The refusal behind the override dialog: fresh, from the server, not the poll. Null when
  // no dialog is open.
  const [refusal, setRefusal] = useState<CompletionRefusal | null>(null);
  // Whether this change is still an idea: its state is set by creation and left by starting, so
  // the select shows the one word and the actions carry the transition.
  const idea = change ? isIdeation(change) : false;

  useEffect(() => {
    if (page === "terminals") setTerminalOpened(true);
  }, [page]);

  // The change itself and the list of components are cheap: no CLI calls behind either.
  useEffect(() => {
    apiClient
      .read(ChangeId.make(id))
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    apiClient
      .cards(ChangeId.make(id))
      .then(setInfos)
      .catch((e: Error) => setError(e.message));
    apiClient
      .tabs(ChangeId.make(id))
      .then(setTabs)
      .catch((e: Error) => setError(e.message));
    apiClient
      .widgets(ChangeId.make(id))
      .then(setWidgets)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // Whether completing is allowed, refreshed alongside the widgets.
  useEffect(() => {
    if (change?.completedAt) return;
    const ac = new AbortController();
    const load = (): Promise<void> =>
      apiClient
        .completion(ChangeId.make(id), { signal: ac.signal })
        .then(setCompletion)
        .catch(() => {}); // keep the last verdict rather than blanking the button
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [id, change?.completedAt, generation]);

  // Which page of the change to show, and the view to come back to: opening a change's
  // overview lands where you left it — its Plan until there is a memory. Remembered for the
  // session and deliberately forgotten by a restart (remember.ts); a terminal is a window of
  // the change, not one of its views, and never claims the memory.
  useEffect(() => {
    const shown = resolveChangePage(page, tabs ?? []);
    if (shown.kind !== "terminals") seeView(id, shown.kind === "tab" ? shown.tab.id : shown.kind);
  }, [id, page, tabs]);

  // A card's editor saved: the change it wrote is the response, the lists elsewhere are stale,
  // and the cards remount to re-read the world — which is also what closes the editor's dialog.
  const saved = (updated: Change): void => {
    setChange(updated);
    onChanged();
    setGeneration((g) => g + 1);
  };

  const copyDescription = (): Promise<void> =>
    apiClient
      .description(ChangeId.make(id))
      .then(({ text }) => navigator.clipboard.writeText(text ?? ""))
      .then(() => {
        setNotice("Pull request description copied");
        setTimeout(() => setNotice(null), 2500);
      })
      .catch((e: Error) => setError(e.message));

  // The button is always available; the requirements are checked on click. Ready completes
  // as before; a refusal opens the override dialog instead of landing in the banner.
  const complete = (force = false): void => {
    setCompleting(true);
    setError(null);
    apiClient
      .complete(ChangeId.make(id), force ? { force: true } : {})
      .then(({ change: updated }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        setRefusal(null);
        forgetChange(id); // the change is over: the page's memory of it stops here
      })
      .catch((e: unknown) => {
        const refusal = completionRefusal(e);
        if (refusal) {
          setRefusal(refusal);
          return;
        }
        // Where a started completion stopped is in the completion card, which reads it from
        // disk; this is only for a refusal before anything started.
        setError(failureMessage(e));
      })
      .finally(() => setCompleting(false));
  };

  /**
   * Start an idea's work: the state moves to In Progress, and the server's start hooks create
   * the checkouts and move the ticket. The terminal stays where it is — the change directory and
   * its agent session are unchanged, so the conversation continues.
   */
  const startWork = (): void => {
    setStarting(true);
    setError(null);
    apiClient
      .start(ChangeId.make(id))
      .then(({ change: updated, provision }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        setAfter(provision);
        onChanged();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setStarting(false));
  };

  // The cancel dialog's state: null when closed, otherwise the unpushed-commits warning —
  // empty until the server names the repositories, one acknowledge like the completion
  // dialog's per-reason ones.
  const [cancelWarning, setCancelWarning] = useState<string[] | null>(null);
  const [cancelAcked, setCancelAcked] = useState(false);

  /**
   * Abandon the change: the worktrees and the terminal go, and everything anyone else can see —
   * branches, pull requests, the ticket — is left alone and listed back to you. The first
   * click opens the dialog; confirming there runs it, and a 409 naming unpushed commits
   * fills in the warning instead of a `window.confirm`.
   */
  const cancel = (force = false): void => {
    if (!force && cancelWarning === null) {
      setCancelWarning([]);
      setCancelAcked(false);
      return;
    }
    setCancelling(true);
    setError(null);
    apiClient
      .cancel(ChangeId.make(id), { force })
      .then(({ change: updated, loose }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        onChanged();
        setCancelWarning(null);
        forgetChange(id); // the change is over: the page's memory of it stops here
        if (loose.length) setNotice(`Cancelled. Still open: ${loose.join("; ")}`);
      })
      .catch((e: unknown) => {
        const needsForce = cancelNeedsForce(e);
        // Commits nobody else has. The branch survives, so this is recoverable — by someone who
        // knows the branch is there, which is worth one question, asked in the dialog.
        if (needsForce) {
          setCancelWarning(needsForce);
          setCancelAcked(false);
          return;
        }
        setCancelWarning(null);
        setError(failureMessage(e));
      })
      .finally(() => setCancelling(false));
  };

  /** The name field's blur: a name the ticket suggested is not a fact — renaming it stops it
   * being refreshed from Jira, and clearing it hands the name back. */
  const commitRename = (next: string): void => {
    setDraft(null);
    if (next === (change?.title ?? "")) return;
    apiClient
      .rename(ChangeId.make(id), { title: next })
      .then((updated) => {
        setChange(updated);
        onChanged();
      })
      .catch((e: Error) => setError(failureMessage(e)));
  };

  /** The state select: your own view of where the change stands. */
  const moveTo = (state: ChangeState): void => {
    apiClient
      .rename(ChangeId.make(id), { state })
      .then((updated) => {
        setChange(updated);
        onChanged(); // the navigation column and the overview list states too
      })
      .catch((e: Error) => setError(failureMessage(e)));
  };

  const actions = changeActions({
    idea,
    starting,
    completing,
    cancelling,
    completion,
    onRename: () => setDraft(change?.title ?? ""),
    onStart: startWork,
    onCopyDescription: copyDescription,
    onComplete: () => complete(),
    onCancel: () => cancel(),
  });

  // The nav the page shows, and which of its tabs is current. A URL naming an id nobody offers
  // — a tab that has gone, a typo — resolves to the plan, so the page still renders.
  const nav = changeNav(tabs ?? []);
  const active = resolveChangePage(page, tabs ?? []);
  const activeId = active.kind === "tab" ? active.tab.id : active.kind;

  /** The window's own row: the change's terminals as tabs, and — on the terminal page — the key
   * reference. The change's name is deliberately not here: the navigation column carries it, and the
   * row is the window's, so both of a change's pages still begin the same way
   * (docs/manual/interface.md). */
  const changeHeader = (
    <header className="change-bar">
      <WindowTabs
        // Which surface is on screen, not which of the change's tabs: this row is the change's
        // views against its terminals, and the row below says which of those views. An unknown
        // segment resolves to the plan, which is one of them.
        page={active.kind}
        windows={windows}
        platform={platform}
        onSelectWindow={onSelectWindow}
        onNewWindow={onNewWindow}
        onMoveWindow={onMoveWindow}
        onOpenOverview={() => onOpenPage(lastViewOf(id))}
      />
      <span className="spacer" />
      {/* The key reference is the terminal's: on the other views the row below carries the
          change's own tabs, state and actions instead. */}
      {active.kind === "terminals" && (
        <button onClick={() => setCheatSheet(true)}>tmux cheat sheet</button>
      )}
    </header>
  );

  return (
    <div className={active.kind === "terminals" ? "page terminal-page" : "page"}>
      {/* The window's title bar: a tab per terminal, and — on the terminal page — the key
          reference. The same row on both of a change's pages. */}
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
      {refusal && (
        <CompleteAnywayDialog
          changeId={id}
          refusal={refusal}
          busy={completing}
          onComplete={() => complete(true)}
          onClose={() => setRefusal(null)}
        />
      )}
      {cancelWarning !== null && (
        <CancelDialog
          changeId={id}
          idea={idea}
          needsForce={cancelWarning}
          acked={cancelAcked}
          busy={cancelling}
          onAck={setCancelAcked}
          onConfirm={() => cancel(cancelWarning.length > 0 && cancelAcked)}
          onClose={() => setCancelWarning(null)}
        />
      )}
      {error && <div className="error-banner">{error}</div>}
      {/* The downgrade fence, said up front: a record from a newer Corvi reads here but every
          write is refused, so the page says so before a button does. */}
      {change && (change.formatVersion ?? 0) > FORMAT_VERSION && (
        <div className="notice">
          this change was written by a newer version of Corvi (record format {change.formatVersion});
          upgrade to edit it
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      {/* Creation's observer failures, shown once where the create was started. */}
      <LifecycleFailures results={provision} />
      {/* A completed or cancelled change's observer failures: the operation itself succeeded, so
          these are reported on its response rather than rendered as a failure of the change. */}
      <LifecycleFailures results={after} />
      {/* The change's own views, and the change's state and actions at the tabs' height: they
          belong to the change rather than to any one of its views, and the row that says which
          view you are in is where they fit — under the window's row rather than in it. */}
      {active.kind !== "terminals" && (
        <ChangeControls
          nav={nav}
          activeId={activeId}
          change={change}
          idea={idea}
          actions={actions}
          draft={draft}
          onDraft={setDraft}
          onOpenPage={onOpenPage}
          onRename={commitRename}
          onState={moveTo}
        />
      )}
      {active.kind === "dashboard" && (
        <ChangeDashboard
          id={id}
          change={change}
          infos={infos}
          widgets={widgets}
          generation={generation}
          completing={completing}
          onSaved={saved}
          onFinished={setChange}
        />
      )}
      {/* The plan is the change's own document: it stays visible once the work starts, and is a
          read-only record once the change is over. Its own tab — a document of the change, not
          a card beside its status — between the dashboard and the tabs extensions contribute. */}
      {active.kind === "plan" &&
        (change ? (
          <PlanPage changeId={id} canBrief={idea} readOnly={isFinished(change)} />
        ) : (
          <p className="hint">loading…</p>
        ))}
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
