import { type JSX, useEffect, useRef } from "react";
import type { Platform } from "../model.ts";

/** tmux keys worth knowing, since the terminal is a tmux session and nothing in the page hints
 * at that. Everything here is plain tmux: nothing IWE invented. */
const KEYS: [string, string][] = [
  ["ctrl-b c", "new window"],
  ["ctrl-b n / p", "next / previous window"],
  ["ctrl-b <number>", "go to window by number"],
  ["ctrl-b w", "list windows and pick one"],
  ["ctrl-b ,", "rename the current window"],
  ["ctrl-b &", "close the current window"],
  ["ctrl-b %", "split left/right"],
  ["ctrl-b \"", "split top/bottom"],
  ["ctrl-b arrows", "move between panes"],
  ["ctrl-b z", "zoom a pane in or out"],
  ["ctrl-b [", "scroll back (q to leave); the wheel does this too"],
  ["ctrl-b d", "detach — the session keeps running"],
];

/**
 * Copying out of a terminal in a browser. The mouse belongs to tmux (mouse mode is on), but tmux
 * hands its own copies to the page as OSC 52, so a plain drag — and a double or triple click —
 * is on the system clipboard by itself. The browser's selection is still one modifier away
 * (option on macOS, shift on Linux, the modifier xterm.js honours on each platform), and the
 * page takes the copy chords: macOS routes ⌘C through the app's Edit menu, while on Linux there
 * is no menu and Ctrl+C belongs to the shell, so it is the Ctrl+Shift pair. Middle-click pastes
 * the system clipboard. tmux's buffers are separate from the clipboard on both.
 */
const COPYING_MAC: [string, string][] = [
  ["drag", "select and copy to the Mac clipboard"],
  ["double-click / triple-click", "copy a word / a line to the clipboard"],
  ["⌥-drag, then ⌘C", "select with xterm itself, then copy"],
  ["⌘V", "paste from the Mac clipboard"],
  ["ctrl-b ]", "paste the tmux buffer — a separate thing from the clipboard"],
];

const COPYING_LINUX: [string, string][] = [
  ["drag", "select and copy to the system clipboard"],
  ["double-click / triple-click", "copy a word / a line to the clipboard"],
  ["Shift+drag", "select with xterm itself; Ctrl+Shift+C copies it"],
  ["Ctrl+Shift+V", "paste the clipboard (Ctrl+V also pastes)"],
  ["middle-click", "paste the system clipboard"],
  ["ctrl-b ]", "paste the tmux buffer — a separate thing from the clipboard"],
];

const copying = (platform: Platform): [string, string][] =>
  platform === "linux" ? COPYING_LINUX : COPYING_MAC;

export function CheatSheet({
  changeId,
  open,
  onClose,
  platform,
}: {
  changeId: string;
  open: boolean;
  onClose: () => void;
  /** The server's platform: the copying rows are its business. */
  platform: Platform;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} onCancel={onClose} onClose={onClose}>
      <h3>tmux cheat sheet</h3>
      <table className="keys">
        <tbody>
          {KEYS.map(([key, what]) => (
            <tr key={key}>
              <td>
                <code>{key}</code>
              </td>
              <td>{what}</td>
            </tr>
          ))}
          <tr>
            <th colSpan={2}>Copying and pasting</th>
          </tr>
          {copying(platform).map(([key, what]) => (
            <tr key={key}>
              <td>
                <code>{key}</code>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        This tab is the tmux session <code>iwe-{changeId}</code>, started in the change directory.
        Reach the same shells from any terminal with <code>tmux -L iwe attach -t iwe-{changeId}</code>.
      </p>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
