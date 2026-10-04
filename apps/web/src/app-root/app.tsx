import {
  type CSSProperties,
  type JSX,
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { apiClient, type Change } from "./api.ts";
import { byWorkOrder, isFinished, isIdeation } from "../domain/change.ts";
import { stateClass } from "./stateClass.ts";
import { ChangeCard } from "./ChangeCard.tsx";
import { moment } from "./moment.ts";
import { Sidebar } from "./Sidebar.tsx";
import { forgetChange, lastViewOf } from "./remember.ts";
import { useChanges, useTerminal, useWindows } from "./state.ts";
import { changeKey, SourceContext, SourcesProvider, useSources } from "./sources.ts";
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
import { hostOf } from "./host.ts";
import { MenuIcon } from "./icons.tsx";
import { useContextMenu } from "./contextMenu.ts";
import { SessionGate } from "./SessionGate.tsx";
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHTS } from "../domain/chrome.ts";
import type { SettingsView } from "../settings/model.ts";
import { ActionsPage } from "../actions/ActionsPage.tsx";
import { SubagentsPage } from "../subagents/SubagentsPage.tsx";

function Home({
  changes,
  error,
  onOpen,
  onNew,
}: {
  // undefined until the list has been read: "none yet" and "not known yet" are different things.
  changes: Change[] | undefined;
  error: string | null;
  onOpen: (change: Change) => void;
  onNew: () => void;
}): JSX.Element {
  // Three lists, because they are read for different reasons: what is still an idea, what is
  // going on, and what happened. Ideas first — they are the newest thing and the thing you have
  // not started — then the active ones in work order, newest first within each.
  const ideas = (changes ?? []).filter(isIdeation).sort(byWorkOrder);
  const active = (changes ?? [])
    .filter((c) => !isFinished(c) && !isIdeation(c))
    .sort(byWorkOrder);
  const finished = (changes ?? [])
    .filter(isFinished)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  return (
    <div className="page">
      <header>
        <h2>Changes</h2>
        <span className="spacer" />
        <button className="create" title="start a new idea" onClick={onNew}>
          New
        </button>
      </header>
      {error && <div className="error-banner">{error}</div>}

      {/* Ideas have their own block above the work: they are a different kind of thing — a
          question, not a job — and reading them as rows among the active changes buries them. */}
      <h2 className="section">Ideas</h2>
      {!changes && !error && <p className="hint">loading…</p>}
      {changes && ideas.length === 0 && (
        <p className="hint">no ideas yet — start one with a title and a plan</p>
      )}
      <div className="change-cards">
        {ideas.map((c) => (
          <ChangeCard key={changeKey(c.source ?? "", c.id)} change={c} onOpen={() => onOpen(c)} />
        ))}
      </div>

      <h2 className="section">Active changes</h2>
      {changes && active.length === 0 && <p className="hint">nothing in progress</p>}
      <div className="change-cards">
        {active.map((c) => (
          <ChangeCard key={changeKey(c.source ?? "", c.id)} change={c} onOpen={() => onOpen(c)} />
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
  const { changes: everything, error, reload } = useChanges();
  const { workspaces, chosen, choose, current: workspace, ready, platform, reload: reloadWorkspaces } = useWorkspaces();
  // The pages the sidebar offers in this context, from the server: which extensions exist and
  // what they contribute is not the page's to know. Undefined ("All work") is the server's
  // default context, which is what a request without a workspace gets.
  // A remote workspace's pages live on its own server; the gateway does not serve them yet, so
  // they are not offered rather than showing the local server's pages under its name.
  const { pages, reload: reloadPages } = usePages(workspace?.id, workspace?.remote === undefined);
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
  const change = (everything ?? []).find(
    (c) => c.id === selected && (c.source ?? "") === selectedSource,
  );
  // A change by id and source, for a notification or a link that names both.
  const sourceOfChange = (id: string): string =>
    (everything ?? []).find((c) => c.id === id)?.source ?? "";
  const onTerminal = view.name === "change" && (view.page === "terminals" || view.page === "subagents");
  // The plan is the tab's content and takes its frame, so its page gives up the padding the
  // way the terminal's does — the editor is the content area, exactly.
  const onPlan = view.name === "change" && view.page === "plan";
  // The terminals belong to the changes, not to the page you are on: the column lists every
  // change's windows, whichever change you are looking at. Pushed by the server, so this costs
  // one connection and no polling.
  const terminals = useWindows();
  // Only once a terminal is asked for: opening a dashboard is not asking for one.
  const [wantsTerminal, setWantsTerminal] = useState(false);
  useEffect(() => setWantsTerminal(false), [selected]);
  useEffect(() => {
    if (onTerminal) setWantsTerminal(true);
  }, [onTerminal]);
  const terminal = useTerminal(selectedSource, selected, Boolean(change?.completedAt), wantsTerminal);

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

  // A notification click comes back through the host as a plain function: activate the window,
  // then open the change and the window it was about. The window id is looked up in the
  // live list, because the index it had when the notification was made may belong to another
  // window by the time it is clicked.
  const openWindow = (change: string, windowId: string): void => {
    const source = sourceOfChange(change);
    const index = (terminals.windows[changeKey(source, change)] ?? []).find((w) => w.id === windowId)?.index;
    setWantsTerminal(true);
    setView({ name: "change", source, id: change, page: "terminals" });
    if (index !== undefined) terminals.select(source, change, index);
  };
  const openWindowRef = useRef(openWindow);
  openWindowRef.current = openWindow;
  useEffect(() => {
    // The contract the host calls after a notification is clicked; the wrapper keeps the
    // registered function from going stale as the view changes. A real browser has no host, and
    // nothing to register.
    hostOf()?.onOpenWindow((change, windowId) => openWindowRef.current(change, windowId));
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
  // or a reload on /azure-devops reads as home until then. Once known, the URL is re-read — the
  // URL is the truth, and this only ever makes it match.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => {
    setViewState(viewOf(window.location.pathname, pages));
  }, [pages]);

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
    apiClient
      .settings.read()
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
  const chrome = {
    "--titlebar-height": `${TITLE_BAR_HEIGHT}px`,
    "--traffic-inset": bridge?.platform === "darwin" ? `${TRAFFIC_LIGHTS.inset}px` : "0px",
  } as CSSProperties;

  return (
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
        onSubagents={() => setView({ name: "subagents" })}
        subagents={view.name === "subagents"}
        onSettings={() => setView({ name: "settings" })}
        settings={view.name === "settings"}
        update={appUpdate.status}
        onUpdate={appUpdate.open}
        onOpenChange={(c) =>
          setView({
            name: "change",
            source: c.source ?? "",
            id: c.id,
            page: lastViewOf(changeKey(c.source ?? "", c.id)),
          })
        }
        onSelectWindow={(c, index) => {
          terminals.select(c.source ?? "", c.id, index);
          setWantsTerminal(true);
          setView({ name: "change", source: c.source ?? "", id: c.id, page: "terminals" });
        }}
      />
      <main className={onTerminal || onPlan ? "content flush" : "content"}>
        {view.name === "home" && (
          <Home
            changes={changes}
            error={error}
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
        {view.name === "ext-page" &&
          (workspace?.remote !== undefined ? (
            <div className="page">
              <header>
                <h2>Another server</h2>
              </header>
              <div className="error-banner">
                This page belongs to a workspace on another server. Corvi's gateway does not serve
                extension pages for remote workspaces yet.
              </div>
            </div>
          ) : (
            <PageHost info={view} workspace={workspace?.id} />
          ))}
        {view.name === "actions" && <ActionsPage onGuard={onGuard} />}
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
            onCreated={(c, provision) => {
              // Only a created change takes the draft: a refused create keeps the form.
              setDraft(undefined);
              void reload();
              // A new change opens on its Plan: the wizard just wrote it, and anything an old
              // record of this id left in the page's memory is not this change's.
              forgetChange(changeKey("", c.id));
              setView({ name: "change", source: "", id: c.id, page: "plan", provision });
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
            key={changeKey(selectedSource, view.id)}
            id={view.id}
            source={selectedSource}
            page={view.page}
            platform={platform}
            provision={view.provision}
            onOpenPage={(page) => setView({ ...view, page, provision: undefined })}
            terminal={{ ...terminal, create: () => void terminals.create(selectedSource, view.id) }}
            windows={terminals.windows[changeKey(selectedSource, view.id)] ?? []}
            onSelectWindow={(index) => {
              terminals.select(selectedSource, view.id, index);
              setWantsTerminal(true);
              // On the dashboard the tab is the way in: selecting a window you cannot see would
              // be a click that does nothing visible.
              setView({ name: "change", source: view.source, id: view.id, page: "terminals" });
            }}
            onFocusWindow={(index) => {
              // Focus the window without leaving the page: the Subagents page has the terminal
              // beside the conversation, so selecting there must not navigate.
              terminals.select(selectedSource, view.id, index);
              setWantsTerminal(true);
            }}
            onNewWindow={() => {
              // A session that has not started has nothing to add a window to: opening the
              // terminal makes its first window.
              if ((terminals.windows[changeKey(selectedSource, view.id)] ?? []).length > 0) {
                void terminals.create(selectedSource, view.id);
              }
              setWantsTerminal(true);
              setView({ name: "change", source: view.source, id: view.id, page: "terminals" });
            }}
            onMoveWindow={(from, to) => terminals.move(selectedSource, view.id, from, to)}
            onChanged={reload}
          />
          </SourceContext.Provider>
        )}
      </main>
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionGate>
      <SourcesProvider>
        <App />
      </SourcesProvider>
    </SessionGate>
  </StrictMode>,
);
