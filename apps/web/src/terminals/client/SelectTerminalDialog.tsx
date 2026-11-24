/** The change's terminal windows, as one list to pick from: the window list's leader key opens it,
 * a digit or the arrows pick a window, and the page switches to the terminal on that window.
 *
 * The tab row above it stays a row of tabs you can click; this is the same choice without having
 * to find the tab, and it is the only place a window's place is said in full. */
import { type JSX, useEffect, useRef, useState } from "react";
import { digitOf } from "../../app-root/leader.tsx";
import { AgentIcon, TerminalIcon } from "../../app-root/icons.tsx";
import type { TerminalWindow } from "../../domain/terminal.ts";

/** The row the cursor is on: the window the arrows moved to while it is still in the list, and the
 * window on screen until they move at all. `-1` when the window it moved to has gone — nothing is
 * highlighted and Enter picks nothing, rather than the row that slid into its place. */
export const cursorRow = (windows: readonly TerminalWindow[], movedTo: string | null): number => {
  if (movedTo !== null) return windows.findIndex((window) => window.id === movedTo);
  const active = windows.findIndex((window) => window.active);
  return active < 0 ? 0 : active;
};

export function SelectTerminalDialog({
  open,
  windows,
  onPick,
  onClose,
}: {
  open: boolean;
  /** The change's windows, in the row's order: the number beside a row is its position here. */
  windows: readonly TerminalWindow[];
  /** Make this window the one on screen, and switch to the terminal view. Named by id: the list
   * arrives again on every poll and shrinks when a window exits, so a position is not an identity. */
  onPick: (windowId: string) => void;
  onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  // The window the arrows have moved to, or null while they have not moved at all. Null is what
  // makes the dialog open on the window you are looking at without an effect that would also run
  // on every refresh of the list (the windows come back from a poll, as a new array, every few
  // seconds). It is an id rather than a position for the same reason the pick is: a window that
  // exits while the list is open must not hand its place to the row that slides into it.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const cursor = cursorRow(windows, movedTo);
  // Where the arrows start from, which is the same cursor except after a window vanished under it:
  // they walk on from the window you can see rather than from nowhere.
  const arrowFrom = cursor >= 0 ? cursor : cursorRow(windows, null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  /** Closed either way, the arrows start over on the window you are looking at next time. */
  const close = (): void => {
    setMovedTo(null);
    onClose();
  };

  // The row's own window, read now: `windows` is the live list, so a row that has gone since the
  // dialog opened picks nothing.
  const pick = (index: number): void => {
    const chosen = windows[index];
    if (chosen === undefined) return;
    onPick(chosen.id);
    close();
  };

  return (
    <dialog
      ref={dialog}
      className="select-terminal-dialog"
      aria-label="select terminal"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        // The dialog owns its keys while it is open. Escape closes without moving; the digits are
        // the row's positions, `0` the tenth; the arrows walk the list and Enter takes the row
        // they are on.
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (windows.length === 0) return;
          const delta = event.key === "ArrowDown" ? 1 : -1;
          const next = windows[(arrowFrom + delta + windows.length) % windows.length];
          if (next !== undefined) setMovedTo(next.id);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          pick(cursor);
          return;
        }
        const slot = digitOf(event.code);
        if (slot === undefined) return;
        event.preventDefault();
        pick(slot);
      }}
    >
      <header>
        <h2>Select terminal</h2>
        <span className="spacer" />
        <button type="button" onClick={close}>
          Cancel
        </button>
      </header>
      {/* A list of rows, each the window it picks: the icon and name the tab carries, and where the
          window is — the server's change-relative form, or the absolute path outside the change. */}
      <ul className="terminal-rows">
        {windows.map((window, index) => (
          <li key={window.id}>
            <button
              type="button"
              className={index === cursor ? "terminal-row current" : "terminal-row"}
              data-window-index={window.index}
              data-window-id={window.id}
              aria-current={window.active ? "true" : undefined}
              onMouseEnter={() => setMovedTo(window.id)}
              onClick={() => pick(index)}
            >
              {/* The number is the row's position, the same one its key is: past the tenth
                  there is no number, and the arrows are the way. */}
              {index < 10 && <kbd aria-hidden="true">{index === 9 ? "0" : String(index + 1)}</kbd>}
              <span className="ic" aria-hidden="true">
                {window.icon === "agent" ? (
                  <AgentIcon title={window.label} />
                ) : (
                  <TerminalIcon title={window.label} />
                )}
              </span>
              <span className="label">{window.title ?? window.label}</span>
              {window.active && <span className="on-screen">current</span>}
              {/* The box truncates from the head, which is why it is right-to-left; the path
                  inside is isolated back to its own direction, or the box's would resolve the
                  leading slash and a leading number to the wrong end. */}
              <span className="where">
                <bdi>{window.where ?? ""}</bdi>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <footer>
        <span className="hint">
          <kbd>1</kbd>–<kbd>9</kbd> pick · <kbd>0</kbd> the tenth · <kbd>↑</kbd>
          <kbd>↓</kbd> walk · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
        </span>
        <span className="spacer" />
      </footer>
    </dialog>
  );
}
