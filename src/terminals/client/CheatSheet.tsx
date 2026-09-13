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
 * Copying out of a terminal in a browser. The mouse belongs to tmux (mouse mode is on), so a
 * plain drag is tmux's selection and the browser's is a modifier away: option on macOS, shift
 * on Linux — the modifier xterm.js honours on each platform. What puts it on the system
 * clipboard differs too: macOS routes ⌘C through the app's Edit menu, while on Linux the page
 * takes the Ctrl+Shift chords (Ctrl+C belongs to the shell, and there is no menu). Middle-click
 * pastes the primary selection. tmux's buffers are separate from either clipboard on both.
 */
const COPYING_MAC: [string, string][] = [
  ["⌥-drag, then ⌘C", "select and copy to the Mac clipboard"],
  ["⌥-double-click", "select a word · ⌥-triple-click selects the line"],
  ["⌘V", "paste from the Mac clipboard"],
  ["drag (no option)", "tmux's own selection, into a tmux buffer"],
  ["ctrl-b ]", "paste the tmux buffer"],
];

const COPYING_LINUX: [string, string][] = [
  ["Shift+drag", "select into the browser's selection — a plain drag is tmux's"],
  ["Ctrl+Shift+C", "copy the selection"],
  ["Ctrl+Shift+V", "paste the clipboard (Ctrl+V also pastes)"],
  ["middle-click", "paste the primary selection, whatever was highlighted last"],
  ["ctrl-b ]", "paste the tmux buffer — a separate thing from the system clipboard"],
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
        Reach the same shells from any terminal with <code>tmux attach -t iwe-{changeId}</code>.
      </p>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
