import { type JSX, useEffect, useRef, useState } from "react";
import { api, type Change } from "./api.ts";
import { stateClass } from "./changeState.tsx";
import { CiIcon, TerminalIcon, AgentIcon } from "./icons.tsx";
import { byWorkOrder, isFinished, type ChangeSummary } from "../core/domain/change.ts";
import type { TerminalWindow } from "../core/domain/terminal.ts";
import { getPref, setPref } from "./prefs.ts";
import { ALL, type Workspace } from "./workspaces.ts";
import type { Platform } from "./newWindowKey.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";

/** Which page of a change is open. The dashboard is what selecting a change opens. */
export type Page = "dashboard" | "review" | "terminals";

/** How wide the column is, remembered between visits: it is furniture, and moving it back every
 * morning would be its own small annoyance. A cookie rather than localStorage: the app serves
 * itself from a fresh port every launch, and localStorage is scoped to the port (see prefs.ts). */
const WIDTH_KEY = "iwe:sidebar-width";
const MIN = 160;
const MAX = 480;

const storedWidth = (): number => {
  const stored = Number(getPref(WIDTH_KEY));
  return stored >= MIN && stored <= MAX ? stored : 220;
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
  pages,
  onPage,
  extPage,
  onSettings,
  settings,
  onOpenChange,
  onSelectWindow,
  onNewWindow,
  platform,
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
  onNewWindow: (id: string) => void;
  /** The server's platform: which chord the new-window hint names. */
  platform: Platform;
}): JSX.Element {
  // What you can get on with first, then what is with somebody else, then what is stuck — and
  // the newest of each at the top. The overview list is sorted the same way.
  const active = (changes ?? []).filter((c) => !isFinished(c)).sort(byWorkOrder);
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
        api<ChangeSummary>(`/changes/${c.id}/summary`)
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
      setWidth(Math.min(MAX, Math.max(MIN, e.clientX)));
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

  return (
    <nav className="sidebar" style={{ width }}>
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

      <button
        className={current || extPage || settings ? "entry" : "entry current"}
        onClick={onHome}
      >
        Changes
      </button>
      <div className="list">
        {active.map((c) => {
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
                title={c.title ?? c.branch}
                onClick={() => onOpenChange(c.id)}
              >
                {/* What it is and how it is doing on the first line, what it is about on the
                    second: the id is what you scan for, the summary is what you read. */}
                <span className="top">
                  <span className="id">{c.id}</span>
                  <Icons summary={summaries[c.id]} />
                </span>
                <span className="subject">{c.title ?? c.branch}</span>
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

              {/* Only where you are working: every change offering a terminal it has not got
                  would be more noise than help. */}
              {selected && (
                <button
                  className="entry sub new-window"
                  // meta is Super on Linux, which the window manager owns: the Linux hint names
                  // the binding that reliably reaches the page.
                  title={
                    platform === "mac"
                      ? "new terminal here (cmd-t, or ctrl-b c)"
                      : "new terminal here (ctrl-alt-t, or ctrl-b c)"
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onNewWindow(c.id)}
                >
                  <TerminalIcon title="new terminal" />
                  <span className="label">new</span>
                </button>
              )}
            </div>
          );
        })}
        {changes && active.length === 0 && <p className="hint">nothing in progress</p>}
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
