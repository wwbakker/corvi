import { type CSSProperties, type JSX, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiClient, type Change } from "./api.ts";
import { byWorkOrder, isFinished, isIdeation } from "../domain/change.ts";
import { stateClass } from "./stateClass.ts";
import { ChangeCard } from "./ChangeCard.tsx";
import { moment } from "./moment.ts";
import { Sidebar } from "./Sidebar.tsx";
import { RemoteAvailabilityBanner, StaleMarker } from "./RemoteAvailability.tsx";
import { forgetChange, lastViewOf } from "./remember.ts";
import { useChanges, useTerminal, useWindows } from "./state.ts";
import {
  changeKey,
  SourceContext,
  SourcesProvider,
  useAvailability,
  useSources,
  useSourceAvailability,
  useSourceOwner,
  WorkspaceSourceContext,
} from "./sources.ts";
import { inWorkspace, usePages, useWorkspaces } from "../workspace/client/workspaces.ts";
import { Wizard } from "../wizard/index.ts";
import { applyPatch, EMPTY_DRAFT, type Draft, type DraftPatch } from "../wizard/draft.ts";
import { ChangeView } from "../change-page/client/ChangeView.tsx";
import { PageHost } from "../integrations/client.tsx";
import { SettingsPage } from "../settings/client/SettingsPage.tsx";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.tsx";
import { pathOf, viewOf, type LeaveGuard, type View } from "./navigation.ts";
import { Notifier } from "./notify.tsx";
import { UpdateNotice } from "../app-update/UpdateNotice.tsx";
import { UpdateDialog } from "../app-update/UpdateDialog.tsx";
import { useAppUpdate } from "../app-update/state.ts";
import { HostRestartDialog } from "../terminals/client/HostRestartDialog.tsx";
import { hostMismatchTitle, useHostRestart } from "../terminals/client/hostRestart.ts";
import { hostOf } from "./host.ts";
import { MenuIcon } from "./icons.tsx";
import { useContextMenu } from "./contextMenu.ts";
import { guardFileDrops } from "./dropGuard.ts";
import { KittyImageShelf, KittyImageShelfContext } from "../terminals/client/kittyImages.ts";
import { SessionGate } from "./SessionGate.tsx";
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHTS } from "../domain/chrome.ts";
import { coloursOf, CORVI_COLOURS } from "../domain/theme.ts";
import { applyChangeColours, applyStoredTheme } from "./theme.ts";
import { applyStoredMonoFont, loadSymbolsFont } from "./monoFont.ts";
import type { SettingsView } from "../settings/model.ts";
import { ActionsPage } from "../actions/ActionsPage.tsx";
import { SubagentsPage } from "../subagents/SubagentsPage.tsx";
import { HarnessProfilesPage } from "../harnesses/HarnessProfilesPage.tsx";
import { LeaderProvider, useLeaderActive } from "./leader.tsx";

function Home({
  changes,
  error,
  stale,
  staleSources,
  newBlocked,
  onOpen,
  onNew,
}: {
  // undefined until the list has been read: "none yet" and "not known yet" are different things.
  changes: Change[] | undefined;
  error: string | null;
  /** Some workspaces are unavailable: the rows below are their last known answers. */
  stale?: boolean;
  /** The sources whose rows are the last known answer, so each card can say so too. */
  staleSources?: readonly string[];
  /** The selected workspace is a remote that cannot be reached: a new idea there cannot be
   * created, so the control is disabled rather than failing at the last step. A local selection
   * is never blocked. */
  newBlocked?: boolean;
  onOpen: (change: Change) => void;
  onNew: () => void;
}): JSX.Element {
  const availability = useAvailability();
  // A change card's cache-backed state is keyed by its source's generation too, so a retargeted
  // remote's card does not show the old target's summary.
  const cardKey = (source: string, id: string): string =>
    `${changeKey(source, id)}@${availability.entries[source]?.generation ?? ""}`;
  // Three lists, because they are read for different reasons: what is still an idea, what is
  // going on, and what happened. Ideas first — they are the newest thing and the thing you have
  // not started — then the active ones in work order, newest first within each.
  const ideas = (changes ?? []).filter(isIdeation).sort(byWorkOrder);
  const active = (changes ?? []).filter((c) => !isFinished(c) && !isIdeation(c)).sort(byWorkOrder);
  const finished = (changes ?? [])
    .filter(isFinished)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  return (
    <div className="page">
      <header>
        <h2>Changes</h2>
        <span className="spacer" />
        <button
          className="create"
          title={newBlocked === true ? "this workspace is unavailable" : "start a new idea"}
          disabled={newBlocked}
          onClick={onNew}
        >
          New
        </button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      {stale === true && (
        <p className="hint">
          <StaleMarker>stale</StaleMarker> an unavailable workspace's last known changes are shown below; they
          are readable, not live.
        </p>
      )}

      {/* Ideas have their own block above the work: they are a different kind of thing — a
          question, not a job — and reading them as rows among the active changes buries them. */}
      <h2 className="section">Ideas</h2>
      {!changes && !error && <p className="hint">loading…</p>}
      {changes && ideas.length === 0 && (
        <p className="hint">no ideas yet — start one with a title and a plan</p>
      )}
      <div className="change-cards">
        {ideas.map((c) => (
          <ChangeCard
            key={cardKey(c.source ?? "", c.id)}
            change={c}
            stale={(staleSources ?? []).includes(c.source ?? "")}
            onOpen={() => onOpen(c)}
          />
        ))}
      </div>

      <h2 className="section">Active changes</h2>
      {changes && active.length === 0 && <p className="hint">nothing in progress</p>}
      <div className="change-cards">
        {active.map((c) => (
          <ChangeCard
            key={cardKey(c.source ?? "", c.id)}
            change={c}
            stale={(staleSources ?? []).includes(c.source ?? "")}
            onOpen={() => onOpen(c)}
          />
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
                <tr key={changeKey(c.source ?? "", c.id)} onClick={() => onOpen(c)}>
                  <td>{c.id}</td>
                  <td className="summary">{c.title ?? c.branch}</td>
                  <td className={stateClass(c.state)}>{c.state ?? "Completed"}</td>
                  <td>{(c.checkouts ?? []).length}</td>
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

function App(): JSX.Element {
  const [view, setViewState] = useState<View>(() =>
    viewOf(window.location.pathname + window.location.search),
  );
  const { reload: reloadSources } = useSources();
  const { changes: everything, error, staleSources, reload } = useChanges();
  const {
    workspaces,
    chosen,
    choose,
    current: workspace,
    ready,
    platform,
    reload: reloadWorkspaces,
  } = useWorkspaces();
  // The pages the sidebar offers in this context, from the context's own server: which extensions
  // exist and what they contribute is not the page's to know. Undefined ("All work") is the local
  // server's default context, which is what a request without a workspace gets. A remote
  // workspace asks its own server through the gateway, naming its own id there (`remote.workspace`),
  // which is also the id a page's own requests carry.
  const owner = useSourceOwner();
  const pageClient = workspace?.remote ? owner.clientFor(workspace.id) : apiClient;
  // The source the page is actually showing, so an unavailable change opened by direct link (or
  // from "All work") banners by its own source, not only by the chosen workspace.
  const viewedSource = view.name === "change" ? (view.source ?? "") : workspace?.remote ? workspace.id : "";
  const viewedName =
    workspaces.find((candidate) => (candidate.remote !== undefined ? candidate.id : "") === viewedSource)
      ?.name ?? "";
  const pageWorkspace = workspace?.remote ? workspace.remote.workspace : workspace?.id;
  // The workspace-scoped page list is keyed by its source's generation: a retarget clears it.
  const pageSource = workspace?.remote ? workspace.id : "";
  const pageAvailability = useSourceAvailability(pageSource);
  // A new idea is created in the selected context: a remote that cannot be reached disables the
  // create controls; a local selection (or All work's local default) stays usable.
  const createSource = workspace?.remote ? workspace.id : "";
  const createBlocked = useSourceAvailability(createSource).status._tag !== "available";
  const {
    pages,
    settled: pagesSettled,
    reload: reloadPages,
  } = usePages(
    pageWorkspace,
    pageClient,
    pageAvailability.generation,
    pageAvailability.status._tag === "available",
  );
  // One context at a time: the lists, the overview and what a new change is made in. Undefined
  // until the contexts are known, which reads as "loading" rather than as "everything".
  const changes = everything && ready ? inWorkspace(everything, chosen, workspaces) : undefined;

  // The idea being written: the wizard's form, owned here so that leaving `/new` does not lose
  // it. A draft is not a change — nothing is written until "Create idea" (apps/web/src/wizard/draft.ts).
  const [draft, setDraft] = useState<Draft>();
  // `/new` is the draft's page: a deep link or Back into it opens a fresh one when there is
  // none. Only on entering the view, so an emptied draft is not quietly re-made.
  useEffect(() => {
    if (view.name === "new") setDraft((d) => d ?? { ...EMPTY_DRAFT });
  }, [view.name]);
  // Patches are applied to what the last render held, so a step may change several fields in
  // one go (an issue pick sets the payload, the ticket and the id) without losing the rest.
  const changeDraft = useCallback(
    (patch: DraftPatch): void => setDraft((d) => (d ? applyPatch(d, patch) : d)),
    [],
  );

  // The navigation drawer a narrow window uses: there the column is an overlay, opened by the
  // toggle and closed by a navigation, Escape, a resize back above the breakpoint, or a click on
  // its backdrop. On a wide window the column is always in the flow and this does nothing.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Leaving a page closes the drawer, whether it was a change, a window, a page, a workspace, or
  // the wizard: the click that navigates leaves the destination visible, not the menu.
  useEffect(() => {
    setDrawerOpen(false);
  }, [view, chosen]);

  // The kitty images every terminal pane has been sent, kept across the pane's remounts.
  const [kittyShelf] = useState(() => new KittyImageShelf());

  // A file dropped beside the terminal is refused rather than opened by another program.
  useEffect(() => guardFileDrops(document), []);

  // Widening past the breakpoint puts the column back in the flow, so the drawer has nothing to
  // cover.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 721px)");
    const onChange = (): void => {
      if (wide.matches) setDrawerOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // Escape is the keyboard's close while the drawer is open. Capture phase, and the key is taken
  // rather than passed on: a terminal underneath encodes keys as input and would swallow it before
  // it bubbled (apps/web/src/app-root/ActionsMenu.tsx).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [drawerOpen]);

  // An open drawer owns the scroll: the content behind it must not move under the pointer.
  useEffect(() => {
    document.body.classList.toggle("drawer-open", drawerOpen);
    return () => document.body.classList.remove("drawer-open");
  }, [drawerOpen]);

  const selected = view.name === "change" ? view.id : null;
  // Found among all of them, not the filtered list: a link to a change in another workspace
  // should open it rather than say it does not exist.
  // The view names both halves of the identity, so a change the filter hides still opens, and a
  // remote change sharing an id with a local one is not confused for it.
  const selectedSource = view.name === "change" ? view.source : "";
  // Keying the change page by (source, id, generation) remounts it on a retarget, clearing its
  // mounted reads and cache-backed state; a same-generation outage does not remount.
  const selectedGeneration = useSourceAvailability(selectedSource).generation;
  const change = (everything ?? []).find((c) => c.id === selected && (c.source ?? "") === selectedSource);
  const onTerminal = view.name === "change" && view.page === "terminals";
  // The plan is the tab's content and takes its frame, so its page gives up the padding the
  // way the terminal's does — the editor is the content area, exactly.
  const onPlan = view.name === "change" && view.page === "plan";
  // The dashboard is the page: its content column is sized so the cards can fill what the chrome
  // leaves instead of guessing the chrome's height.
  const onDashboard = view.name === "change" && view.page === "dashboard";
  // The terminals belong to the changes, not to the page you are on: the column lists every
  // change's windows, whichever change you are looking at. Pushed by the server, so this costs
  // one connection and no polling.
  const terminals = useWindows();
  // Whether a window exists decides whether there is anything to attach to: a change with none
  // shows its empty terminal view instead, and nothing asks the server for a socket URL.
  const changeWindows =
    selected === null ? undefined : terminals.windows[changeKey(selectedSource, selected)];
  // The page's own intent keeps a terminal page live. The remembered flag keeps a terminal that
  // was opened earlier attached while the same change shows a non-terminal view, so Plan and back
  // do not clear the URL and close the socket. The OR is what makes a direct A -> B terminal
  // switch work without giving up the hidden-pane behavior.
  const [wantsTerminal, setWantsTerminal] = useState(false);
  useEffect(() => setWantsTerminal(false), [selected]);
  useEffect(() => {
    if (onTerminal) setWantsTerminal(true);
  }, [onTerminal]);
  const terminal = useTerminal(
    selectedSource,
    selected,
    Boolean(change?.completedAt),
    (onTerminal || wantsTerminal) && (changeWindows?.length ?? 0) > 0,
  );

  // Spaces lights the page with the open change's own colour pair; the overview, the wizard and
  // the pages that belong to no change keep Corvi's own pair. The values are what the theme's sky
  // reads, and it glides from one pair to the next (`--hue-a`/`--hue-b` in styles.css).
  const changeColours = change === undefined ? CORVI_COLOURS : coloursOf(change.id, isIdeation(change));
  // Which change the pair belongs to, so only a real move between two changes glides: the first
  // pair of a page load, and a move to or from the overview, are painted.
  const colourSource = useRef<string | null>(null);
  const colourKey = change === undefined ? "" : `${change.source ?? ""}\u0000${change.id}`;
  useEffect(() => {
    const previous = colourSource.current;
    const animate = previous !== null && previous !== "" && colourKey !== "" && previous !== colourKey;
    colourSource.current = colourKey;
    applyChangeColours(changeColours, animate);
  }, [changeColours.from, changeColours.to, colourKey]);

  // Navigating pushes a history entry; Back and a reload both land on the same page. A page
  // with unsaved edits publishes a leave guard (app-root/navigation.ts); while it is dirty, the
  // navigation is held and UnsavedChangesDialog gives the three answers.
  const guard = useRef<LeaveGuard | null>(null);
  const onGuard = useCallback((next: LeaveGuard | null): void => {
    guard.current = next;
  }, []);
  // The navigation the guard held up — with what the guard says is unsaved, its own words for
  // the prompt — and whether its save is running.
  const [leaving, setLeaving] = useState<{ target: View; subject: string } | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);

  const applyView = (next: View): void => {
    if (pathOf(next) !== window.location.pathname + window.location.search)
      window.history.pushState(null, "", pathOf(next));
    setViewState(next);
  };
  const setView = (next: View): void => {
    // Clicking the page you are on is not leaving it: the guard has nothing to say.
    if (guard.current?.dirty && pathOf(next) !== window.location.pathname + window.location.search) {
      setLeaving({ target: next, subject: guard.current.subject });
      return;
    }
    applyView(next);
  };

  // The prompt's three answers. A proceed drops the guard first, so a stale one can never block
  // the page being opened; Stay — what Escape does — changes nothing.
  const stay = (): void => {
    setLeaving(null);
  };
  const discardAndLeave = (): void => {
    if (!leaving) return;
    const held = leaving.target;
    guard.current = null;
    setLeaving(null);
    applyView(held);
  };
  const saveAndLeave = async (): Promise<void> => {
    if (!leaving) return;
    const held = leaving.target;
    setLeaveSaving(true);
    // The page's own save, so a failure is the page's own: the dialog closes, the page's error
    // banner explains, and the draft and its guard both stay.
    const saved = (await guard.current?.save()) ?? false;
    setLeaveSaving(false);
    if (!saved) {
      setLeaving(null);
      return;
    }
    guard.current = null;
    setLeaving(null);
    applyView(held);
  };

  /** Give up on the idea being written: the draft goes, and there is nothing else to show. */
  const discardDraft = (): void => {
    setDraft(undefined);
    setView({ name: "home" });
  };

  // A notification click comes back with the source it was about: activate the window, then open
  // that source's change — resolved by (source, change), so a remote notice for a change that
  // shares an id with a local one does not open the local one. The window is selected by the id
  // the notice carries: the index it had when the notification was made may belong to another
  // window by the time it is clicked, and it may have gone altogether, which the server answers
  // rather than the page guessing at a position.
  const openWindow = (source: string, change: string, windowId: string): void => {
    setView({ name: "change", source, id: change, page: "terminals" });
    terminals.select(source, change, windowId);
  };
  const openWindowRef = useRef(openWindow);
  openWindowRef.current = openWindow;
  useEffect(() => {
    // The contract the host calls after a notification is clicked; the wrapper keeps the
    // registered function from going stale as the view changes. A real browser has no host, and
    // nothing to register.
    hostOf()?.onOpenWindow((change, windowId, source) =>
      openWindowRef.current(source ?? "", change, windowId),
    );
  }, []);

  useEffect(() => {
    const onPop = (): void => {
      const next = viewOf(window.location.pathname + window.location.search, pagesRef.current);
      if (guard.current?.dirty) {
        // The history pointer has already moved, so the guarded view's own URL is pushed back:
        // the page on screen stays the one the URL names, and the popped target waits in the
        // prompt. Which page that is belongs to the guard, not to here.
        window.history.pushState(null, "", pathOf(guard.current.view));
        setLeaving({ target: next, subject: guard.current.subject });
        return;
      }
      setViewState(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The pages are the server's, and they may arrive after the first view was resolved: a link
  // or a reload on /azure-devops reads as home until then. Once known, the whole URL is re-read
  // (search included, as the initial state and popstate do). Only the views whose existence
  // depends on the page list are re-resolved: a change view does not, and rebuilding it would
  // drop the `?source=` that names its server and the transient `provision` a creation just put
  // on it — neither of which the URL can restore.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => {
    setViewState((current) => {
      // A retarget clears the page list while it re-reads. Keep the open page across that clear so
      // it can remount for the new target (its key carries the generation); leave it only once the
      // settled list says the target no longer offers it. Without the settle check, the clearing
      // alone would navigate home and lose the page.
      if (current.name === "ext-page" && !pagesSettled) return current;
      if (current.name !== "home" && current.name !== "ext-page") return current;
      return viewOf(window.location.pathname + window.location.search, pages);
    });
  }, [pages, pagesSettled]);

  // What the OS calls this window: the change's name, where Mission Control, the Dock menu and
  // the task switcher read it. The page draws no title of its own — its first row is the
  // change's — so this is the one place the window says what it is showing. index.html's title
  // is what it says on the pages that are about no change.
  useEffect(() => {
    document.title = change?.title ?? change?.branch ?? "Corvi";
  }, [change]);

  // The right-click menu is the host's to draw and the setting's to decide (apps/web/src/app-root/contextMenu.ts).
  // Read here rather than in the settings page, because the page has to behave by it either way.
  const [contextMenu, setContextMenu] = useState(true);
  const reloadSettings = useCallback((): void => {
    apiClient.settings
      .read()
      .then((view) => setContextMenu(view.effective.contextMenu))
      .catch(() => {
        // A settings file that cannot be read leaves the default: a menu, like any browser.
      });
  }, []);
  useEffect(reloadSettings, [reloadSettings]);
  useContextMenu(contextMenu);

  // The window's own chrome, where there is a window: the height of the page's first row, and the
  // traffic lights macOS keeps in it (apps/web/src/domain/chrome.ts). A browser has neither, so the row is
  // an ordinary one and nothing is laid out around it.
  const bridge = hostOf();
  // The app's own new version: the icon in the column's bottom row, the notice, and the dialog
  // behind them (apps/web/src/app-update/state.ts).
  const appUpdate = useAppUpdate();
  // The terminal host this server is not running, and the restart it offers instead of taking
  // (apps/web/src/terminals/client/hostRestart.ts).
  const hostRestart = useHostRestart();
  const chrome = {
    "--titlebar-height": `${TITLE_BAR_HEIGHT}px`,
    "--traffic-inset": bridge?.platform === "darwin" ? `${TRAFFIC_LIGHTS.inset}px` : "0px",
  } as CSSProperties;

  // Leader mode's keys sit on the column, so on a window narrow enough to have it as a drawer,
  // the mode opens it and closes it again — unless you had opened it yourself. Read on the
  // transition only: closing the drawer during the mode is yours to do, not something the mode
  // undoes (app-root/leader.tsx).
  const leaderActive = useLeaderActive();
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  const leaderOpenedDrawer = useRef(false);
  // Where the last press landed. A press inside the drawer ends the mode on mousedown, and closing
  // the drawer then would take the control out from under the click: the gesture finishes first
  // (app-root/leader.tsx).
  const pressedInDrawer = useRef(false);
  const leaderActiveRef = useRef(leaderActive);
  leaderActiveRef.current = leaderActive;
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      // Only the press that ends the mode is this flag's business, and it is read in the effect
      // that ends it. A press while the mode is off must not leave it set for a later session.
      if (!leaderActiveRef.current) return;
      // The drawer's own controls, and the toggle that closes it, finish their press before the
      // drawer may move: a navigation closes it, and the toggle closes it itself.
      pressedInDrawer.current =
        event.target instanceof Element && event.target.closest(".sidebar, .drawer-toggle") !== null;
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);
  useEffect(() => {
    if (leaderActive) {
      // A flag from a press in an earlier session is not this session's.
      pressedInDrawer.current = false;
      if (!window.matchMedia("(max-width: 720px)").matches) return;
      leaderOpenedDrawer.current = !drawerOpenRef.current;
      setDrawerOpen(true);
      return;
    }
    if (!leaderOpenedDrawer.current) return;
    leaderOpenedDrawer.current = false;
    if (pressedInDrawer.current) {
      // The click on the drawer's control navigates, and that closes it; a click on its blank
      // space leaves it open, which is what was pressed.
      pressedInDrawer.current = false;
      return;
    }
    setDrawerOpen(false);
  }, [leaderActive]);
  // A window that narrows under the mode has to give it the drawer too: the column is
  // off-screen otherwise, and its keys would be alive with nothing on screen to learn them from.
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 720px)");
    const onChange = (): void => {
      if (!leaderActive || !narrow.matches) return;
      leaderOpenedDrawer.current = leaderOpenedDrawer.current || !drawerOpenRef.current;
      setDrawerOpen(true);
    };
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  }, [leaderActive]);

  return (
    <KittyImageShelfContext.Provider value={kittyShelf}>
      <div className={bridge ? "app hosted" : "app"} style={chrome}>
        {/* The narrow window's navigation: a backdrop, and the toggle that stays above it (and the
          drawer) so it can close what it opened. Both exist only below the breakpoint. */}
        {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
        <button
          className={drawerOpen ? "drawer-toggle open" : "drawer-toggle"}
          title={drawerOpen ? "close navigation" : "open navigation"}
          aria-label="Navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <MenuIcon title="Navigation" />
        </button>
        <Notifier
          change={selected}
          source={selectedSource}
          page={view.name === "change" ? view.page : "dashboard"}
          windows={selected ? (terminals.windows[changeKey(selectedSource, selected)] ?? []) : []}
          onOpen={openWindow}
        />
        <UpdateNotice
          status={appUpdate.status}
          visible={appUpdate.notice}
          onOpen={appUpdate.open}
          onDismiss={appUpdate.dismissNotice}
        />
        <Sidebar
          open={drawerOpen}
          changes={changes}
          workspaces={workspaces}
          chosen={chosen}
          onChooseWorkspace={choose}
          current={change ?? (selected ? ({ id: selected, source: selectedSource } as Change) : undefined)}
          page={view.name === "change" ? view.page : "dashboard"}
          windows={terminals.windows}
          onHome={() => setView({ name: "home" })}
          onNew={() => setView({ name: "new" })}
          newBlocked={createBlocked}
          draft={draft}
          wizard={view.name === "new"}
          // The server's pages, offered as they are: which extensions exist here is not the
          // page's to know.
          pages={pages}
          onPage={(id) => {
            const page = pages.find((p) => p.id === id);
            if (page) setView({ name: "ext-page", id: page.id, extension: page.extension });
          }}
          extPage={view.name === "ext-page" ? view.id : undefined}
          onActions={() => setView({ name: "actions" })}
          actions={view.name === "actions"}
          onHarnesses={() => setView({ name: "harnesses" })}
          harnesses={view.name === "harnesses"}
          onSubagents={() => setView({ name: "subagents" })}
          subagents={view.name === "subagents"}
          onSettings={() => setView({ name: "settings" })}
          settings={view.name === "settings"}
          update={appUpdate.status}
          onUpdate={appUpdate.open}
          hostReason={
            hostRestart.stale && hostRestart.status !== null
              ? hostMismatchTitle(hostRestart.status.stale)
              : undefined
          }
          onRestartHost={hostRestart.open}
          onOpenChange={(c) =>
            setView({
              name: "change",
              source: c.source ?? "",
              id: c.id,
              page: lastViewOf(changeKey(c.source ?? "", c.id)),
            })
          }
          onSelectWindow={(c, windowId) => {
            terminals.select(c.source ?? "", c.id, windowId);
            setView({ name: "change", source: c.source ?? "", id: c.id, page: "terminals" });
          }}
        />
        {/* The banner and the page share the space beside the column: the banner is a row above the
          content, not a third column of the app's row layout. */}
        <div className="app-body">
          <RemoteAvailabilityBanner
            source={viewedSource}
            name={viewedName}
            onSettings={() => setView({ name: "settings" })}
          />
          <main
            className={`content${onTerminal || onPlan ? " flush" : ""}${onDashboard ? " dashboard" : ""}`}
          >
            {view.name === "home" && (
              <Home
                changes={changes}
                error={error}
                stale={staleSources.length > 0}
                staleSources={staleSources}
                newBlocked={createBlocked}
                onOpen={(c) =>
                  setView({
                    name: "change",
                    source: c.source ?? "",
                    id: c.id,
                    page: lastViewOf(changeKey(c.source ?? "", c.id)),
                  })
                }
                onNew={() => setView({ name: "new" })}
              />
            )}
            {view.name === "ext-page" && (
              // A page belongs to the workspace that is selected; the source tells its own requests
              // which server to reach through the gateway, and the workspace prop names its id there.
              <WorkspaceSourceContext.Provider value={pageSource}>
                {/* The page belongs to this target and to this page: a same-id retarget remounts it
                rather than carrying the old target's React state (an expanded row, a half-filled
                dialog) onto the new one. A same-generation outage keeps the key, so the page
                keeps its loaded facts, and its transport's identity is what re-reads on recovery.
                The disabled fieldset is the read-only boundary: a blocked workspace disables the
                page's controls without unmounting it. Settings is not a PageHost, so its local
                editor is deliberately outside this boundary. */}
                <fieldset
                  key={`${pageSource}\u0000${pageAvailability.generation}\u0000${pageWorkspace ?? ""}\u0000${view.extension}\u0000${view.id}`}
                  className="widgets-fieldset"
                  disabled={pageAvailability.status._tag !== "available"}
                >
                  <PageHost info={view} workspace={pageWorkspace} />
                </fieldset>
              </WorkspaceSourceContext.Provider>
            )}
            {view.name === "actions" && <ActionsPage onGuard={onGuard} />}
            {view.name === "harnesses" && <HarnessProfilesPage onGuard={onGuard} />}
            {view.name === "subagents" && <SubagentsPage onGuard={onGuard} />}
            {view.name === "settings" && (
              <SettingsPage
                onGuard={onGuard}
                onSaved={() => {
                  // A save may have toggled an extension's enablement, which the workspaces carry
                  // and the sidebar's pages answer to — both are asked again — and it may have
                  // changed the right-click menu, which this shell behaves by.
                  reloadWorkspaces();
                  reloadPages();
                  reloadSettings();
                  // A save may have added or retargeted a remote workspace: the sources follow.
                  reloadSources();
                }}
              />
            )}
            {view.name === "new" && draft && (
              <Wizard
                workspaces={workspaces}
                workspace={workspace?.id}
                draft={draft}
                onChange={changeDraft}
                onCreated={(c, provision, source) => {
                  // Only a created change takes the draft: a refused create keeps the form.
                  setDraft(undefined);
                  void reload();
                  // A new change opens on its Plan: the wizard just wrote it, and anything an old
                  // record of this id left in the page's memory is not this change's.
                  forgetChange(changeKey(source, c.id));
                  // The source it was created in: a remote workspace's change routes to its server
                  // from here on, exactly as one read from its list does.
                  setView({ name: "change", source, id: c.id, page: "plan", provision });
                }}
                onDiscard={discardDraft}
              />
            )}
            {view.name === "change" && (
              <SourceContext.Provider value={selectedSource}>
                <ChangeView
                  // Keyed by the change: its state — the cached reads, the notes and plan being typed,
                  // the widgets, the open terminal — belongs to one change. Reusing the instance across
                  // a switch is what let the previous change's notes stay on screen after its read
                  // came back, with nothing left to read them again (apps/web/src/change-page/client/ChangeView.tsx).
                  key={`${changeKey(selectedSource, view.id)}@${selectedGeneration}`}
                  id={view.id}
                  source={selectedSource}
                  page={view.page}
                  platform={platform}
                  provision={view.provision}
                  onOpenPage={(page) => setView({ ...view, page, provision: undefined })}
                  terminal={terminal}
                  windows={terminals.windows[changeKey(selectedSource, view.id)] ?? []}
                  // An answered list with no entry for this change means it has no windows; a source
                  // that has not answered is not known. Source-level, so a change worked on elsewhere
                  // reads as "none" until the next look corrects it.
                  windowsKnown={terminals.fresh[selectedSource] === true}
                  windowError={terminals.errors[changeKey(selectedSource, view.id)]}
                  onWindowsCreated={(windows) => terminals.adopt(selectedSource, view.id, windows)}
                  onSelectWindow={(windowId) => {
                    terminals.select(selectedSource, view.id, windowId);
                    // On the dashboard the tab is the way in: selecting a window you cannot see would
                    // be a click that does nothing visible.
                    setView({ name: "change", source: view.source, id: view.id, page: "terminals" });
                  }}
                  onNewWindow={() => {
                    // The dialog is the one place a terminal is created; this only brings its page
                    // up. The dialog's own action creates the window once a choice is made.
                    setView({ name: "change", source: view.source, id: view.id, page: "terminals" });
                  }}
                  onMoveWindow={(from, to) => terminals.move(selectedSource, view.id, from, to)}
                  onRenameWindow={(windowId, title) =>
                    terminals.rename(selectedSource, view.id, windowId, title)
                  }
                  onChanged={reload}
                />
              </SourceContext.Provider>
            )}
          </main>
        </div>
        {leaving && (
          <UnsavedChangesDialog
            subject={leaving.subject}
            busy={leaveSaving}
            onSaveAndLeave={() => void saveAndLeave()}
            onDiscardAndLeave={discardAndLeave}
            onStay={stay}
          />
        )}
        {appUpdate.dialog && appUpdate.status && (
          <UpdateDialog
            status={appUpdate.status}
            busy={appUpdate.busy}
            checking={appUpdate.checking}
            error={appUpdate.error}
            canRestart={appUpdate.canRestart}
            onClose={appUpdate.close}
            onCheck={appUpdate.check}
            onStart={appUpdate.start}
            onRestart={appUpdate.restart}
          />
        )}
        {hostRestart.dialog && hostRestart.status !== null && (
          <HostRestartDialog
            status={hostRestart.status}
            busy={hostRestart.busy}
            error={hostRestart.error}
            onClose={hostRestart.close}
            onRestart={hostRestart.restart}
          />
        )}
      </div>
    </KittyImageShelfContext.Provider>
  );
}

// The theme this device chose, before the first render. `index.html`'s own script already set it
// ahead of the first paint; this applies it again for what a small script trusts and this module
// validates, and puts the sky's follow and the browser chrome on it.
applyStoredTheme();
// The monospace face this device chose, likewise before anything monospace is drawn.
applyStoredMonoFont();
// The icon font, before the first render rather than when the first icon needs it. Chromium keeps
// the boxes it drew for text laid out while the font was still loading (seen in the editor), and a
// font that lands after the render makes CodeMirror re-measure, so the page shifts under the
// reader. Locally it takes milliseconds; a slow remote link waits at most this long, then the
// page renders and the font arrives late.
const SYMBOLS_FONT_WAIT_MS = 1000;
await Promise.race([
  loadSymbolsFont(),
  new Promise<void>((resolve) => setTimeout(resolve, SYMBOLS_FONT_WAIT_MS)),
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionGate>
      <SourcesProvider>
        <LeaderProvider>
          <App />
        </LeaderProvider>
      </SourcesProvider>
    </SessionGate>
  </StrictMode>,
);
