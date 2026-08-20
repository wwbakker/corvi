import { useEffect, useRef } from "react";

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

/** Copying out of a terminal in a browser: the mouse belongs to tmux, so the browser's own
 * selection needs shift. tmux's buffers and the Mac clipboard are separate things. */
const COPYING: [string, string][] = [
  ["⌥-drag, then ⌘C", "select and copy to the Mac clipboard"],
  ["⌥-double-click", "select a word · ⌥-triple-click selects the line"],
  ["⌘V", "paste from the Mac clipboard"],
  ["drag (no shift)", "tmux's own selection, into a tmux buffer"],
  ["ctrl-b ]", "paste the tmux buffer"],
];

export function CheatSheet({
  changeId,
  open,
  onClose,
}: {
  changeId: string;
  open: boolean;
  onClose: () => void;
}) {
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
          {COPYING.map(([key, what]) => (
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
