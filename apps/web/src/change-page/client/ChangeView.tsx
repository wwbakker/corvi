import { type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import {
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
import type { RemoteAvailabilityReasonDto } from "@corvi/contracts/availability";
import { changeKey, useChangeClient, useSourceAvailability } from "../../app-root/sources.ts";
import { LifecycleFailures } from "../../app-root/LifecycleFailures.tsx";
import { TerminalPane } from "../../terminals/client/TerminalPane.tsx";
import { CheatSheet } from "../../terminals/client/CheatSheet.tsx";
import type { Platform } from "@corvi/terminals/model";
import { CompleteAnywayDialog } from "./CompleteAnywayDialog.tsx";
import { CancelDialog } from "./CancelDialog.tsx";
import { forceQuestion, completionRefusal, isConflict } from "./refusals.ts";
import { WindowTabs } from "../../terminals/client/WindowTabs.tsx";
import type { Page } from "../../app-root/Sidebar.tsx";
import { changeNav, resolveChangePage, type ChangeTabInfo } from "./changeTabs.ts";
import { forgetChange, seeView } from "../../app-root/remember.ts";
import { changeActions } from "./changeActions.ts";
import { ChangeControls } from "./ChangeControls.tsx";
import { NewTerminalDialog, type NewTerminalOpener } from "../../terminals/client/NewTerminalDialog.tsx";
import { SelectTerminalDialog } from "../../terminals/client/SelectTerminalDialog.tsx";
import { ChangeHarnessesDialog } from "../../harnesses/ChangeHarnessesDialog.tsx";
import { ChangeDashboard } from "./ChangeDashboard.tsx";
import { PlanPage } from "./PlanPage.tsx";
import { TranscriptsPage } from "./TranscriptsPage.tsx";
import { useTerminalActions } from "../../actions/terminalActions.ts";
import { TabHost, type WidgetInfo } from "../../integrations/client.tsx";
import { DashboardIcon, PageIcon, PlanIcon, ReviewIcon } from "../../app-root/icons.tsx";
import { useLeaderGroup } from "../../app-root/leader.tsx";

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
  source,
  page,
  platform,
  provision,
  terminal,
  windows,
  windowsKnown,
  windowError,
  onSelectWindow,
  onNewWindow,
  onMoveWindow,
  onRenameWindow,
  onOpenPage,
  onChanged,
  onWindowsCreated,
}: {
  id: string;
  /** Which server owns this change: `""` for the local one, the local workspace id for a remote
   * one. Every change-scoped call goes to `clientFor(source)`. */
  source: string;
  /** Which page of the change to show: the core's dashboard or terminals, or a tab an
   * extension contributes. */
  page: Page;
  /** Results of the creation step, shown once: it is the one moment something can fail
   * without you having clicked it. */
  provision?: ProvisionResult[];
  /** The change's terminal session, owned by the app so the navigation column can list its
   * windows from any page. */
  terminal: {
    url: string | null;
    error: string | null;
    /** The change's workspace is unavailable; the pane says why instead of connecting. */
    unavailable?: RemoteAvailabilityReasonDto | null;
  };
  /** This change's terminal windows: what the terminal page's tabs are. */
  windows: TerminalWindow[];
  /** Whether the window list has been read at all. An unread list is not an empty one: the page
   * must not say "no terminal" on the strength of a read that has not happened. */
  windowsKnown: boolean;
  /** What this change's last terminal selection/creation failed with, if anything. */
  windowError?: string;
  /** Switching the session to one of its windows, named by id: the row reorders, so a position
   * is not the window it points at by the time the choice is sent. */
  onSelectWindow: (windowId: string) => void;
  /** Bring the terminal view up for a new window. The window itself is created by the dialog, on
   * its own success path; this only makes sure the page is where the new shell will be. */
  onNewWindow: () => void;
  /** A dragged tab landed: the window at `from` takes the place of the one at `to`. */
  onMoveWindow: (from: number, to: number) => void;
  /** Name a window from its tab's menu, or clear the name (blank) back to the default. */
  onRenameWindow: (windowId: string, title: string) => void;
  /** Switching between the change's own pages, which are tabs rather than navigation: they are
   * views of the same change, not separate places. */
  onOpenPage: (page: Page) => void;
  /** The change was renamed, completed or otherwise altered: the lists elsewhere are stale. */
  onChanged: () => void;
  /** The new-terminal dialog opened windows: its answer is the change's list, which the store
   * takes as a mutation's answer, so no read is needed and none leaves a gap to see. */
  onWindowsCreated: (windows: readonly TerminalWindow[]) => Promise<void>;
  /** The server's platform: what the terminal's key hints and shortcut assume. */
  platform: Platform;
}): JSX.Element {
  const client = useChangeClient();
  // Null while the dialog is closed; otherwise how it was opened, which is what its key hints
  // answer to.
  const [newTerminal, setNewTerminal] = useState<NewTerminalOpener | null>(null);
  const [selectTerminalOpen, setSelectTerminalOpen] = useState(false);
  const [harnessDialogOpen, setHarnessDialogOpen] = useState(false);
  // The change's own source, not the chosen workspace: a direct link or "All work" banners too.
  const availability = useSourceAvailability(source);
  const blocked = availability.status._tag !== "available";
  const sourceGeneration = availability.generation;
  const key = changeKey(source, id);
  // Cached reads are keyed by target generation: a same-id retarget must not show the old
  // target's change, tabs, widgets, completion or plan, while a same-target outage keeps them.
  const cacheKey = `${key}@${sourceGeneration}`;
  const [change, setChange] = useCached<Change>(`${cacheKey}:change`);
  // Per change, not global: which components there are depends on the workspace it is in.
  const [infos, setInfos] = useCached<CardInfo[]>(`${cacheKey}:integrations`);
  // The tabs the change's page shows, per change for the same reason: they depend on the
  // workspace, and the server resolves that.
  const [tabs, setTabs] = useCached<ChangeTabInfo[]>(`${cacheKey}:tabs`);
  // The client-drawn widgets the dashboard shows, per change for the same reason.
  const [widgets, setWidgets] = useCached<WidgetInfo[]>(`${cacheKey}:widgets`);
  const [completion, setCompletion] = useCached<Completion>(`${cacheKey}:completion`);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reopening, setReopening] = useState(false);
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
  // A finished change has a Transcripts tab: the agent sessions kept when it was archived.
  const finished = change ? isFinished(change) : false;

  useEffect(() => {
    if (page === "terminals") setTerminalOpened(true);
  }, [page]);

  // The change itself and the list of components are cheap: no CLI calls behind either. A
  // blocked source is not asked; `blocked`/`sourceGeneration` in the deps re-read it on recovery
  // and re-read a retargeted target.
  useEffect(() => {
    if (blocked) return;
    client.changes
      .read(ChangeId.make(id))
      .then(setChange)
      .catch((e: Error) => setError(e.message));
    client.dashboard
      .cards(ChangeId.make(id))
      .then(setInfos)
      .catch((e: Error) => setError(e.message));
    client.dashboard
      .tabs(ChangeId.make(id))
      .then(setTabs)
      .catch((e: Error) => setError(e.message));
    client.dashboard
      .widgets(ChangeId.make(id))
      .then(setWidgets)
      .catch((e: Error) => setError(e.message));
  }, [id, source, client, blocked, sourceGeneration]);

  // Whether completing is allowed, refreshed alongside the widgets.
  useEffect(() => {
    if (change?.completedAt || blocked) return;
    const ac = new AbortController();
    const load = (): Promise<void> =>
      client.changes
        .completion(ChangeId.make(id), { signal: ac.signal })
        .then(setCompletion)
        .catch(() => {}); // keep the last verdict rather than blanking the button
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [id, source, client, change?.completedAt, generation, blocked, sourceGeneration]);

  // Which page of the change to show, and the view to come back to: opening a change's
  // overview lands where you left it — its Plan until there is a memory. Remembered for the
  // session and deliberately forgotten by a restart (remember.ts); a terminal is a window of
  // the change, not one of its views, and never claims the memory.
  useEffect(() => {
    const shown = resolveChangePage(page, tabs ?? [], { finished });
    if (shown.kind !== "terminals") seeView(key, shown.kind === "tab" ? shown.tab.id : shown.kind);
  }, [id, page, tabs, finished]);

  // A card's editor saved: the change it wrote is the response, the lists elsewhere are stale,
  // and the cards remount to re-read the world — which is also what closes the editor's dialog.
  const saved = (updated: Change, provision?: readonly ProvisionResult[]): void => {
    setChange(updated);
    onChanged();
    setGeneration((g) => g + 1);
    // An edit provisions its new checkouts too; what they reported is the same banner a
    // checkout run leaves behind.
    if (provision?.length) setAfter([...provision]);
  };

  const copyDescription = (): Promise<void> =>
    client.changes
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
    client.changes
      .complete(ChangeId.make(id), force ? { force: true } : {})
      .then(({ change: updated }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        setRefusal(null);
        forgetChange(key); // the change is over: the page's memory of it stops here
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

  // The cancel dialog's state: null when closed, otherwise what would be discarded — empty
  // until the server names it, one acknowledge like the completion dialog's per-reason ones.
  const [cancelWarning, setCancelWarning] = useState<string[] | null>(null);
  const [cancelAcked, setCancelAcked] = useState(false);

  /**
   * Abandon the change: the worktrees and the terminal go, and everything anyone else can see —
   * branches, pull requests, the ticket — is left alone and listed back to you. The first
   * click opens the dialog; confirming there runs it, and a 409 naming untracked files or
   * unpushed commits fills in the warning instead of a `window.confirm`.
   */
  const cancel = (force = false): void => {
    if (!force && cancelWarning === null) {
      setCancelWarning([]);
      setCancelAcked(false);
      return;
    }
    setCancelling(true);
    setError(null);
    client.changes
      .cancel(ChangeId.make(id), { force })
      .then(({ change: updated, loose }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        onChanged();
        setCancelWarning(null);
        forgetChange(key); // the change is over: the page's memory of it stops here
        if (loose.length) setNotice(`Cancelled. Still open: ${loose.join("; ")}`);
      })
      .catch((e: unknown) => {
        const needsForce = forceQuestion(e);
        // Untracked files, or commits nobody else has: worth one question, asked in the dialog,
        // naming what goes.
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

  /**
   * Undo a cancellation: the change comes back in the phase it was cancelled from, its worktrees
   * are made again, and the work cancelling shelved is put back. What did not come back cleanly —
   * a checkout that failed, a shelf with conflicts — is said here; the shelf itself stays.
   */
  const reopen = (): void => {
    setReopening(true);
    setError(null);
    setNotice(null);
    client.changes
      .reopen(ChangeId.make(id))
      .then(({ change: updated, provision, restored }) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        setAfter(provision);
        onChanged();
        const lines = restored.map(({ repository, outcome }) =>
          outcome._tag === "Applied"
            ? `${repository}: the shelved work is back`
            : outcome._tag === "Conflicts"
              ? `${repository}: the shelved work conflicts in ${outcome.files.join(", ")} — resolve it; the shelf is kept`
              : outcome._tag === "NotClean"
                ? `${repository}: the checkout has changes, so the shelf was not applied; apply it from the Changes tab`
                : `${repository}: the shelf was not applied (${outcome.reason}); it is kept`,
        );
        setNotice(lines.length ? `Reopened. ${lines.join(" · ")}` : "Reopened.");
      })
      .catch((e: unknown) => setError(failureMessage(e)))
      .finally(() => setReopening(false));
  };

  /** A conflict means this page's snapshot is stale: re-read the record that won, so the next
   * click is decided on it rather than confusing the user with a second refusal. */
  const refetchAfterConflict = (e: unknown): void => {
    if (!isConflict(e)) return;
    client.changes
      .read(ChangeId.make(id))
      .then((reread) => {
        setChange(reread);
        // The cards and the completion poll are decided on the same snapshot: a conflict means
        // they are stale too.
        setGeneration((g) => g + 1);
      })
      .catch(() => {}); // the banner already says what happened
  };

  /** The name field's blur: a name the ticket suggested is not a fact — renaming it stops it
   * being refreshed from Jira, and clearing it hands the name back. */
  const commitRename = (next: string): void => {
    // An unavailable workspace has nowhere to write the name: hold it back and keep the draft
    // open (and editable again on recovery) rather than losing what was typed.
    if (blocked) return;
    setDraft(null);
    if (next === (change?.title ?? "")) return;
    client.changes
      .rename(ChangeId.make(id), { title: next })
      .then((updated) => {
        setChange(updated);
        onChanged();
      })
      .catch((e: unknown) => {
        setError(failureMessage(e));
        refetchAfterConflict(e);
      });
  };

  // One phase write at a time: a second click arrives with the snapshot the first is about to
  // replace, and would be refused for no reason the user can see.
  const [moving, setMoving] = useState(false);

  /** The state select: your own view of where the change stands. Leaving `Ideation` is where the
   * ticket moves, so the cards re-read the world afterwards — the Jira card would otherwise show
   * a ticket that has already moved. */
  const moveTo = (state: ChangeState): void => {
    // The select is disabled while blocked; this is the same rule at the handler, so a programmatic
    // or stale event cannot make the write.
    if (blocked || moving) return;
    setMoving(true);
    client.changes
      .rename(ChangeId.make(id), { state })
      .then((updated) => {
        setChange(updated);
        setGeneration((g) => g + 1);
        onChanged(); // the navigation column and the overview list states too
      })
      .catch((e: unknown) => {
        setError(failureMessage(e));
        refetchAfterConflict(e);
      })
      .finally(() => setMoving(false));
  };

  const actions = changeActions({
    completing,
    moving,
    cancelling,
    completion,
    blocked,
    onRename: () => setDraft(change?.title ?? ""),
    onCopyDescription: copyDescription,
    onComplete: () => complete(),
    onCancel: () => cancel(),
  });

  // The windows' actions are the change's menu's too: one menu, with the change's own endings at
  // the top and the window's work under them (actions/terminalActions.ts).
  const terminalActions = useTerminalActions({
    changeId: id,
    windows,
    disabled: blocked,
    onOpenCheatSheet: () => setCheatSheet(true),
    onRan: () => setFocusRequest((n) => n + 1),
    onNotice: setNotice,
  });

  // The nav the page shows, and which of its tabs is current. A URL naming an id nobody offers
  // — a tab that has gone, a typo — resolves to the plan, so the page still renders.
  const nav = changeNav(tabs ?? [], { finished });
  const active = resolveChangePage(page, tabs ?? [], { finished });
  const activeId = active.kind === "tab" ? active.tab.id : active.kind;

  // The row's controls, in the order the leader reads them: the views, then the terminals and
  // their "+", then the title row's two menus — which sit above the row but come last, so the
  // views keep the keys nearest the row's start (app-root/leader.tsx).
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabRowRef = useRef<HTMLDivElement>(null);
  const newWindowRef = useRef<HTMLButtonElement>(null);
  /** Every new terminal goes through the dialog: the "+" tab and its leader key both land here.
   * Opening it is all this does — nothing is created, and the page does not move — so Cancel
   * leaves the change exactly as it was. */
  const openNewTerminal = (opener: NewTerminalOpener): void => {
    setNewTerminal(opener);
  };
  const hasWindows = windows.length > 0;
  const statusRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);
  /** The element the window list's key sits on: the row's last window, because the strip around it
   * is `display: contents` and has no box of its own to put a keycap on. With no windows there is
   * nothing to pick, so the entry has no element and takes no key — a key that would open an empty
   * list is the same lie as a key on a control that is not there. Read from the page rather than
   * from the render that registered the group: the group's factory runs when the keys come up, and
   * the windows are whatever is there then. */
  const windowListTarget = (): HTMLElement | null => {
    const tabs = tabRowRef.current?.querySelectorAll<HTMLElement>("nav.window-tabs [data-window-index]");
    return tabs === null || tabs === undefined || tabs.length === 0 ? null : (tabs[tabs.length - 1] ?? null);
  };
  // The view row's keys, in the order the controls are drawn: the views, "+", the window list, then
  // the title row's two menus (which sit above the row but come last). The wizard registers the
  // same letters under its own id: the two surfaces never mount together, so one row serves both
  // and a key means the same position in each. Each cap sits above its control's trailing corner:
  // the tabs are 2px apart, so a cap to the right of one would land on the next, and the label
  // under an inside cap reads as part of the key.
  useLeaderGroup("view", "asdfghjkl", () => [
    ...nav.map((tab) => ({
      kind: "target" as const,
      element: tabRefs.current.get(tab.id) ?? null,
      align: "above" as const,
    })),
    // "+" opens the new-terminal dialog with its key hints showing: the leader is what advertised
    // the keys, so the dialog keeps the promise.
    {
      kind: "target",
      element: newWindowRef.current,
      align: "above",
      run: () => openNewTerminal("keyboard"),
    },
    // The window list is one control to pick from, not a group of numbered tabs: its key opens the
    // dialog, which lists the windows with their places, one row each.
    { kind: "target", element: windowListTarget(), align: "above", run: () => setSelectTerminalOpen(true) },
    { kind: "target", element: statusRef.current, keep: true },
    { kind: "target", element: actionsRef.current, keep: true },
  ]);

  /** The pane the terminal shows: the active window's focused pane, so the socket attaches to
   * that pane's own pty and switching windows or panes reconnects. A split window's other panes
   * are composed in 5b; the page renders the active one for now. */
  const activeWindow = windows.find((window) => window.active);
  const activePaneId = activeWindow?.activePane ?? activeWindow?.id ?? null;

  // A change you arrive at with no window keeps its terminal view: that is where "+" is, and it is
  // how the first window is opened. The last window going is the other case — the shell you were
  // typing in exited and the view has nothing left to show — so the dashboard, where the change
  // still is, is where you land.
  const hadWindows = useRef(hasWindows);
  useEffect(() => {
    const before = hadWindows.current;
    hadWindows.current = hasWindows;
    if (before && !hasWindows && windowsKnown && active.kind === "terminals") onOpenPage("dashboard");
  }, [hasWindows, windowsKnown, active.kind, onOpenPage]);

  /** The change's views, and its terminal windows beside them, in one row under the title: a view
   * and a window are both one click away, and the separator is what says they are different kinds
   * of thing. The key reference belongs to the terminal alone. */
  const changeTabs = (
    <div className="change-tabs" ref={tabRowRef}>
      <nav className="tabs views">
        {nav.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => {
              if (element === null) tabRefs.current.delete(tab.id);
              else tabRefs.current.set(tab.id, element);
            }}
            className={activeId === tab.id ? "tab current" : "tab"}
            onClick={() => onOpenPage(tab.id)}
          >
            <span className="ic" aria-hidden="true">
              {tab.id === "plan" ? (
                <PlanIcon title={tab.title} />
              ) : tab.id === "dashboard" ? (
                <DashboardIcon title={tab.title} />
              ) : tab.id === "review" ? (
                <ReviewIcon title={tab.title} />
              ) : (
                <PageIcon title={tab.title} />
              )}
            </span>
            {tab.title}
          </button>
        ))}
      </nav>
      <span className="tab-separator" aria-hidden="true" />
      <WindowTabs
        leaderNewRef={newWindowRef}
        terminals={active.kind === "terminals"}
        windows={windows}
        disabled={blocked}
        onSelectWindow={onSelectWindow}
        onNewWindow={openNewTerminal}
        onMoveWindow={onMoveWindow}
        onRenameWindow={onRenameWindow}
        onRenameClosed={() => {
          // The dialog held the keyboard; once it has closed the terminal takes it back. The pane's
          // refocus only runs while it is visible, so the dashboard is unaffected.
          setFocusRequest((n) => n + 1);
        }}
      />
    </div>
  );

  return (
    <div
      className={
        active.kind === "terminals"
          ? "page terminal-page"
          : active.kind === "dashboard"
            ? "page dashboard-page"
            : "page"
      }
    >
      {/* The title row and the tab row are one sticky block: nothing sits between them, and the
          wrapper carries the stickiness so neither row needs an offset that tracks the other's
          height. The title row is the window's in the app; the row under it is the change's. */}
      <div className="change-chrome">
        <ChangeControls
          statusRef={statusRef}
          actionsRef={actionsRef}
          change={change}
          blocked={blocked}
          actions={[
            ...actions,
            ...(change === undefined
              ? []
              : [
                  {
                    label: "Harnesses…",
                    onSelect: () => setHarnessDialogOpen(true),
                  },
                ]),
            ...terminalActions.actions,
          ]}
          onActionsOpen={terminalActions.refresh}
          draft={draft}
          onDraft={setDraft}
          onRename={commitRename}
          onState={moveTo}
          moving={moving}
          reopening={reopening}
          onReopen={reopen}
        />
        {changeTabs}
      </div>
      <CheatSheet
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
          reasons={cancelWarning}
          acked={cancelAcked}
          busy={cancelling}
          onAck={setCancelAcked}
          onConfirm={() => cancel(cancelWarning.length > 0 && cancelAcked)}
          onClose={() => setCancelWarning(null)}
        />
      )}
      {(error ?? windowError) && <div className="error-banner">{error ?? windowError}</div>}
      {/* The downgrade fence, said up front: a record from a newer Corvi reads here but every
          write is refused, so the page says so before a button does. */}
      {change && (change.formatVersion ?? 0) > FORMAT_VERSION && (
        <div className="notice">
          this change was written by a newer version of Corvi (record format {change.formatVersion}); upgrade
          to edit it
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      {/* Creation's observer failures, shown once where the create was started. */}
      <LifecycleFailures results={provision} />
      {/* A completed or cancelled change's observer failures: the operation itself succeeded, so
          these are reported on its response rather than rendered as a failure of the change. */}
      <LifecycleFailures results={after} />
      {/* The view slot: one wrapper for whichever change view is showing, keyed by that view, so
          arriving at a view is the transition — core views and extension tabs alike, with no list
          of roots to maintain. `display: contents` keeps the wrapper out of the layout. The
          terminal is the one view that stays mounted, so it arrives with a class instead. */}
      {active.kind !== "terminals" && (
        <div className="view-slot" key={activeId}>
          {active.kind === "dashboard" && (
            <ChangeDashboard
              id={id}
              change={change}
              infos={infos}
              widgets={widgets}
              generation={generation}
              blocked={blocked}
              completing={completing}
              onSaved={saved}
              onFinished={setChange}
              onOpenPage={onOpenPage}
            />
          )}
          {/* The plan is the change's own document: it stays visible once the work starts, and is
              a read-only record once the change is over. Its own tab — a document of the change,
              not a card beside its status — between the dashboard and the tabs extensions
              contribute. */}
          {active.kind === "plan" &&
            (change ? (
              <PlanPage
                changeId={id}
                source={source}
                generation={sourceGeneration}
                readOnly={isFinished(change) || blocked}
              />
            ) : (
              <p className="hint">loading…</p>
            ))}
          {active.kind === "transcripts" && <TranscriptsPage changeId={id} />}
          {/* An extension's own tab. It gets the change, which may still be loading: nothing to
              hand it means a hint rather than a crash. */}
          {active.kind === "tab" &&
            (change ? (
              <TabHost key={active.tab.id} info={active.tab} change={change} workspace={change.workspace} />
            ) : (
              <p className="hint">loading…</p>
            ))}
        </div>
      )}
      {/* The terminal page's pane: the only place a pty is attached, so it is unmounted while a
          non-terminal view shows and re-attaches when you come back — and it exists only while the
          change has a window to attach to. A change with none shows the empty view below instead,
          and no socket is asked for. */}
      {terminalOpened && hasWindows && (
        <div
          className={active.kind === "terminals" ? "terminal-host view-arrives" : "terminal-host"}
          hidden={active.kind !== "terminals"}
        >
          <TerminalPane
            changeId={id}
            url={terminal.url}
            sessionId={activePaneId}
            error={terminal.error}
            unavailable={terminal.unavailable}
            visible={active.kind === "terminals"}
            focusRequest={focusRequest}
            platform={platform}
          />
        </div>
      )}
      {/* Nothing to attach to, and the list that says so has been read: the view is a place you
          can sit, with the "+" the way in. Left blank while the list is unread, which is not the
          same claim as "none". */}
      {active.kind === "terminals" && windowsKnown && !hasWindows && (
        <div className="terminal-empty">
          <p className="hint">No terminal in this change yet — open one with +.</p>
        </div>
      )}
      {change !== undefined && (
        <ChangeHarnessesDialog
          open={harnessDialogOpen}
          change={change}
          client={client}
          blocked={blocked}
          onClose={() => setHarnessDialogOpen(false)}
          onChanged={onChanged}
        />
      )}
      {change !== undefined && (
        <NewTerminalDialog
          open={newTerminal !== null}
          opener={newTerminal ?? "pointer"}
          change={change}
          client={client}
          currentDirectory={activeWindow?.cwd}
          onClose={() => setNewTerminal(null)}
          onCreated={async (windows) => {
            // OK is what opens a terminal. The dialog's answer is the change's windows, so the
            // store has them before the page moves: there is no round trip in which the terminal
            // view would say the change has none.
            await onWindowsCreated(windows);
            onNewWindow();
            setFocusRequest((n) => n + 1);
          }}
        />
      )}
      {change !== undefined && (
        <SelectTerminalDialog
          open={selectTerminalOpen}
          windows={windows}
          onPick={onSelectWindow}
          onClose={() => setSelectTerminalOpen(false)}
        />
      )}
    </div>
  );
}
