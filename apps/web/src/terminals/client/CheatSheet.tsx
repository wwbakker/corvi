import { type JSX, useEffect, useRef } from "react";
import type { Platform } from "@corvi/terminals/model";

/** The terminal page's own surface: a host session rendered by xterm.js, so the mouse, the
 * scrollbar, find and the context menu are the page's. */
const KEYS: [string, string][] = [
  ["drag", "select; double and triple click select a word and a line"],
  ["wheel / scrollbar", "scroll back through the history"],
  ["right-click", "copy, paste, select all, clear, find, open a link"],
  ["middle-click", "paste the system clipboard"],
];

/** Chords the page takes, which differ by platform the way the rest of the app's do. */
const CHORDS_MAC: [string, string][] = [
  ["⌘T", "new window"],
  ["⌘F", "find in the terminal (Enter next, ⇧Enter previous, Esc closes)"],
  ["⌘+ / ⌘- / ⌘0", "font size up / down / reset"],
  ["⌥-drag", "select text while a mouse-aware program (pi) is running"],
  ["⌘-click", "open a link"],
  ["⌘C", "copy the selection"],
  ["⌘V", "paste"],
  ["ctrl+shift+c / ctrl+shift+v", "copy / paste, the cross-platform chords"],
];

const CHORDS_LINUX: [string, string][] = [
  ["ctrl-alt-t", "new window"],
  ["ctrl+f", "find in the terminal (Enter next, shift+Enter previous, Esc closes)"],
  ["ctrl+ / ctrl- / ctrl0", "font size up / down / reset"],
  ["shift-drag", "select text while a mouse-aware program (pi) is running"],
  ["ctrl-click", "open a link"],
  ["ctrl+shift+c", "copy the selection"],
  ["ctrl+shift+v", "paste (ctrl+v also pastes)"],
  ["ctrl+insert / shift+insert", "copy / paste (the terminal convention)"],
  ["super+c / super+v", "copy / paste"],
];

const chords = (platform: Platform): [string, string][] =>
  platform === "linux" ? CHORDS_LINUX : CHORDS_MAC;

export function CheatSheet({
  open,
  onClose,
  platform,
}: {
  open: boolean;
  onClose: () => void;
  /** The server's platform: the chords are its business. */
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
      <h3>Terminal cheat sheet</h3>
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
            <th colSpan={2}>The page's chords</th>
          </tr>
          {chords(platform).map(([key, what]) => (
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
        The terminal is a host session: the shell outlives this page and the server, and every
        window — including a subagent's — is one of these sessions, switched from the strip above
        the terminal.
      </p>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
