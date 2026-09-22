import { type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { apiClient, type Change } from "./api.ts";
import { stateClass } from "./stateClass.ts";
import { CiIcon, TerminalIcon, AgentIcon } from "./icons.tsx";
import { byWorkOrder, IDEATION, isFinished, isIdeation, type ChangeSummary } from "../domain/change.ts";
import { TRAFFIC_LIGHTS } from "../domain/chrome.ts";
import type { TerminalWindow } from "../domain/terminal.ts";
import { draftLabel, type Draft } from "../wizard/draft.ts";
import { getPref, setPref } from "./prefs.ts";
import { ALL, type Workspace } from "../workspace/client/workspaces.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { hostOf } from "./host.ts";

/** Which page of a change is open. The dashboard is what selecting a change opens; terminals is
 * the core's own, and any other id is a tab an extension contributed — the id is the last
 * segment of the change's URL. */
export type Page = "dashboard" | "terminals" | (string & {});

/** How wide the column is, remembered between visits: it is furniture, and moving it back every
 * morning would be its own small annoyance. A cookie rather than localStorage: the app serves
 * itself from a fresh port every launch, and localStorage is scoped to the port (see prefs.ts). */
const WIDTH_KEY = "corvi:sidebar-width";
const MIN = 160;
const MAX = 480;

/** The app window's first row starts with the traffic lights on macOS (apps/web/src/domain/chrome.ts), and
 * the switcher sits to their right: there the column cannot be narrower than the space they take
 * plus a switcher you can read. Truncating that control is not a narrower column, it is a broken
 * one. A browser has no lights and keeps the column's own minimum. */
const minWidth = (): number =>
  hostOf()?.platform === "darwin" ? MIN + TRAFFIC_LIGHTS.inset : MIN;

const storedWidth = (): number => {
  const stored = Number(getPref(WIDTH_KEY));
  return stored >= minWidth() && stored <= MAX ? stored : Math.max(220, minWidth());
};

const CI_WORDS: Record<string, string> = {
  ok: "builds green",
  pending: "building",
  error: "build failing",
  warn: "builds need attention",
  none: "no builds",
};

/** What the change's builds are doing. Its own state is the coloured bar down the left of the
 * row, and its terminals are the rows underneath, so neither needs an icon here. */
function Icons({ summary }: { summary?: ChangeSummary }): JSX.Element {
  const ci = summary?.state ?? "none";
  return (
    <span className="icons">
      <span className={summary ? `state-${ci}` : "state-idle"}>
        <CiIcon title={CI_WORDS[ci] ?? "builds"} />
      </span>
    </span>
  );
}

/**
 * The one navigation element: a single column, from the top of the window down.
 *
 * The whole hierarchy is visible at once — the changes, the pages of the one you picked, and the
 * terminals inside it — so moving anywhere is one click from anywhere.
 */
export function Sidebar({
  changes,
  workspaces,
  chosen,
  onChooseWorkspace,
  current,
  page,
  windows,
  onHome,
  onNew,
  draft,
  wizard,
  pages,
  onPage,
  extPage,
  onSettings,
  settings,
  onOpenChange,
  onSelectWindow,
}: {
  /** Every change of the chosen workspace; the list below "Changes" shows the ones still going. */
  changes: Change[] | undefined;
  /** The contexts there are to switch between, and which one is on. */
  workspaces: Workspace[];
  chosen: string;
  onChooseWorkspace: (id: string) => void;
  current?: Change;
  page: Page;
  /** Every change's tmux windows, keyed by change: the terminals sit under their own change. */
  windows: Record<string, TerminalWindow[]>;
  onHome: () => void;
  /** Start an idea: it belongs beside the Ideas heading, where the entries it adds to begin —
   * and it is the same control the overview's header has. It opens the draft already there. */
  onNew: () => void;
  /** The idea being written, if there is one: the row under Ideas that leads back to it. */
  draft?: Draft;
  /** Whether the wizard is the page open: the draft row is current then, and the overview is
   * not. */
  wizard: boolean;
  /** The pages the server says this context has, under Changes: one entry per page. */
  pages: { id: string; title: string }[];
  onPage: (id: string) => void;
  /** The id of the extension page that is open, when one is: it belongs to no change. */
  extPage?: string;
  onSettings: () => void;
  /** Whether the settings page is the one open. */
  settings: boolean;
  onOpenChange: (id: string) => void;
  onSelectWindow: (id: string, index: number) => void;
}): JSX.Element {
  // What you can get on with first, then what is with somebody else, then what is stuck — and
  // the newest of each at the top. The overview list is sorted the same way.
  const live = (changes ?? []).filter((c) => !isFinished(c)).sort(byWorkOrder);
  // Ideas are a different kind of thing — a question, not a job — so they get their own block
  // above the work rather than sitting in the attention order among it.
  const ideas = live.filter(isIdeation);
  const active = live.filter((c) => !isIdeation(c));
  const [width, setWidth] = useState(storedWidth);
  const dragging = useRef(false);
  const [summaries, setSummaries] = useState<Record<string, ChangeSummary>>({});

  // The same numbers the overview cards show, for the icons. One request per change, from the
  // cache on the server, and slowly: this is a glance, not a monitor.
  const ids = active.map((c) => c.id).join("|");
  useEffect(() => {
    let alive = true;
    const load = (): void =>
      active.forEach((c) =>
        apiClient
          .summary(ChangeId.make(c.id))
          .then((s) => alive && setSummaries((all) => ({ ...all, [c.id]: s })))
          .catch(() => {}),
      );
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ids]);

  // Dragging the edge: listened for on the window, so the pointer may leave the handle — which
  // it always does, since the thing being dragged moves out from under it.
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragging.current) return;
      e.preventDefault(); // otherwise the drag selects the text it passes over
      setWidth(Math.min(MAX, Math.max(minWidth(), e.clientX)));
    };
    const up = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("resizing");
      setPref(WIDTH_KEY, String(width));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [width]);

  /** One change in the column, with its terminals under it. Shared by the two blocks — ideas, and
   * the work they become — so a change looks the same in both. Adding a terminal is the window
   * tabs' job (apps/web/src/terminals/client/WindowTabs.tsx): the column is for going to the ones there
   * are, and it says nothing about windows a change has not got. */
  const entry = (c: Change): JSX.Element => {
    const mine = windows[c.id] ?? [];
    const selected = c.id === current?.id;
    // One thing is highlighted at a time. On a terminal that thing is the window, not the
    // change it belongs to: two highlights would be two answers to "where am I".
    const here = selected && page !== "terminals";
    return (
      <div key={c.id} className="change-entry">
        <button
          // The bar down the left is the change's own state, in the usual colours.
          className={`entry sub change ${stateClass(c.state)}${here ? " current" : ""}`}
          title={c.branch}
          onClick={() => onOpenChange(c.id)}
        >
          {/* One line: the change's name, and how it is doing. The branch is the tooltip above,
              which is where the id has gone — it is what the branch starts with, and the row has
              room for one of the two. */}
          <span className="top">
            <span className="subject">{c.title ?? c.branch}</span>
            <Icons summary={summaries[c.id]} />
          </span>
        </button>

        {/* The change's terminals, under the change they belong to. The server says what
            each window is called and which glyph it draws; the page renders that. */}
        {mine.map((w) => (
          <button
            key={w.index}
            className={
              selected && page === "terminals" && w.active
                ? "entry sub window current"
                : "entry sub window"
            }
            title={`ctrl-b ${w.index} — ${w.detail}`}
            // Focus is what a mousedown moves, and a terminal you cannot type in after
            // clicking is useless. Preventing the default keeps it in the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectWindow(c.id, w.index)}
          >
            <span className={w.state === "ok" ? "state-ok" : "state-idle"}>
              {w.icon === "agent" ? <AgentIcon title={w.label} /> : <TerminalIcon title={w.label} />}
            </span>
            <span className="label">{w.label}</span>
            {/* Not for the window you are looking at: you see its output already. */}
            {w.activity && !(selected && page === "terminals" && w.active) && (
              <span className="bell" title="new output" />
            )}
          </button>
        ))}
      </div>
    );
  };

  return (
    <nav className="sidebar" style={{ width }}>
      {/* The window's own top row: on macOS the traffic lights sit here, and in the app window it
          is what you drag the window by (apps/web/src/domain/chrome.ts). The switcher moves up into it so
          the column's first row lines up with the page's strip beside it. A browser has no lights
          and nothing to drag, and the row is where the switcher has always been. */}
      <div className="band">
        {/* Which client's world this is. Everything below is what that context contains, so it
            belongs above everything rather than beside it. Always shown, even with one
            workspace: which context you are in should be visible, not implied. */}
        <ActionsMenu
          className="workspace"
          label={`${workspaces.find((w) => w.id === chosen)?.name ?? "All work"} ▾`}
          actions={[
            ...workspaces.map((w) => ({
              label: w.name,
              disabled: w.id === chosen,
              onSelect: () => onChooseWorkspace(w.id),
            })),
            { label: "All work", separated: true, disabled: chosen === ALL, onSelect: () => onChooseWorkspace(ALL) },
          ]}
        />
      </div>

      {/* The overview. The way to start one left this row for the Ideas heading below, where the
          entries it adds to begin. */}
      <button
        className={current || extPage || settings || wizard ? "entry" : "entry current"}
        onClick={onHome}
      >
        Changes
      </button>
      <div className="list">
        {/* Ideas first, under their own heading: they are the newest thing and the one thing you
            have not started. The work they become follows in attention order. The heading is the
            New button's home — it sits with the entries it adds to, and stays there with no
            ideas and no draft. */}
        <div className="ideas-row">
          <p className="group-label">Ideas</p>
          <button className="create" title="start a new idea" onClick={onNew}>
            New
          </button>
        </div>
        {/* The draft is not a change yet — nothing has been written — so it appears as an idea
            that is still being written, above the ideas that exist. Clicking it is the way back
            into the wizard, wherever you left it. */}
        {draft && (
          <div className="change-entry">
            <button
              className={`entry sub change ${stateClass(IDEATION)}${wizard ? " current" : ""}`}
              title="not created yet — open it to finish or discard it"
              onClick={onNew}
            >
              <span className="top">
                <span className="subject">{draftLabel(draft)}</span>
              </span>
            </button>
          </div>
        )}
        {ideas.map(entry)}
        {active.length > 0 && <p className="group-label">Changes</p>}
        {active.map(entry)}
        {changes && live.length === 0 && <p className="hint">nothing in progress</p>}
      </div>

      {/* Not under a change, because they are not about one: the extensions' pages, offered
          as the server lists them — a context without the extension has no entry, not an
          empty one. Settings stays hardcoded below: it is the core's own. */}
      {pages.map((p) => (
        <button
          key={p.id}
          className={extPage === p.id ? "entry current" : "entry"}
          onClick={() => onPage(p.id)}
        >
          {p.title}
        </button>
      ))}

      {/* At the bottom of the column, not below the list: it is where you go once in a while,
          and it should be in the same place whether you have two changes or nine. */}
      <button className={`entry bottom${settings ? " current" : ""}`} onClick={onSettings}>
        Settings
      </button>

      {/* The whole edge is the handle, because that is where you aim for. */}
      <div
        className="resize"
        title="drag to resize"
        onMouseDown={() => {
          dragging.current = true;
          document.body.classList.add("resizing");
        }}
      />
    </nav>
  );
}
