import { type JSX, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AgentIcon, TerminalIcon } from "../../app-root/icons.tsx";
import type { Platform } from "@corvi/terminals/model";
import type { TerminalWindow } from "../../domain/terminal.ts";
import type { Page } from "../../app-root/Sidebar.tsx";

/** The change's windows as tabs, with the way back to the dashboard first. The dashboard and
 * the terminal both show this strip — a window is one click from either — and because it is
 * one element, the contents are the same on both: the same icon in the same colour, the same
 * name. */
export function WindowTabs({
  page,
  windows,
  platform,
  onSelectWindow,
  onNewWindow,
  onMoveWindow,
  onOpenOverview,
}: {
  /** Which surface of the change is on screen: its own views — the dashboard, or one of the tabs it
   * contributes — or one of its terminals. The strip is drawn on both, and the Overview tab stands
   * for all of the former, so it stays current while any of them is showing rather than only for the
   * dashboard. */
  page: Page;
  /** This change's tmux windows: what the terminal page's tabs are. */
  windows: TerminalWindow[];
  /** The server's platform: what the new-terminal tab's shortcut assumes. */
  platform: Platform;
  /** Switching the session to one of its windows. */
  onSelectWindow: (index: number) => void;
  /** Another window beside the current one. The terminal's own chord does this from inside it;
   * this is the tab that does. */
  onNewWindow: () => void;
  /** A dragged tab landed: the window at `from` takes the place of the one at `to`. */
  onMoveWindow: (from: number, to: number) => void;
  /** The way back to the change's own views, wherever in them you left off (remember.ts): from
   * a terminal this is the way out, and while a view is showing the tab is already current. */
  onOpenOverview: () => void;
}): JSX.Element {
  // Which window tab a drag is carrying, and which one it is over: the fixed ends of the strip
  // — overview and "new" — take no part in either.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

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
    const move = (ev: MouseEvent): void => {
      // A few pixels of travel: a click that wobbles is still a click.
      if (!dragging && Math.abs(ev.clientX - startedAt) < 4) return;
      dragging = true;
      setDragIndex(from);
      setDropIndex(under(ev.clientX, ev.clientY));
    };
    const up = (ev: MouseEvent): void => {
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

  return (
    <nav className="window-tabs">
      {/* The way back to what the change is doing. On the dashboard the tab is already where
          you are; in the terminal it is the way out. */}
      <button
        // Any of the change's own views, not only the dashboard: the row under this one says which of
        // them, and a terminal is the only thing here that is not one.
        className={page === "terminals" ? "window-tab overview" : "window-tab overview current"}
        title="the change's overview"
        onClick={onOpenOverview}
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
}
