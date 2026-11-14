import { type JSX, useEffect, useRef } from "react";

/**
 * What cancelling does, said before it happens: the worktrees and the terminal go, everything
 * anyone else can see stays, and nothing is lost — uncommitted work is shelved in the change and
 * reopening puts it back. Commits nobody else has get one acknowledge, naming them: they survive
 * on the branch, which stays for a reopen.
 */
export function CancelDialog({
  changeId,
  idea,
  reasons,
  acked,
  busy,
  onAck,
  onConfirm,
  onClose,
}: {
  changeId: string;
  idea: boolean;
  /** What would be discarded, one line per reason, once the server has named it; empty
   * beforehand. */
  reasons: string[];
  acked: boolean;
  busy: boolean;
  onAck: (acked: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  // The warning arrives after the first confirm attempt: until then the button cannot know
  // whether there is anything to acknowledge, so it waits for the acknowledge instead.
  const ready = reasons.length === 0 || acked;

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>
        {idea ? `Discard ${changeId}?` : `Cancel ${changeId}?`}
      </h3>
      <p className="hint">
        {idea
          ? "It is archived as cancelled; reopen it to pick it up again. Uncommitted work in its " +
            "worktrees is shelved with it."
          : "The worktrees and the terminal go; uncommitted work is shelved in the change, and " +
            "reopening it puts everything back. The branches, pull requests and the ticket are " +
            "left alone — you will be told what is left."}
      </p>
      {reasons.length > 0 && (
        <>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>
            <label className="ack">
              <input
                type="checkbox"
                checked={acked}
                disabled={busy}
                onChange={(e) => onAck(e.target.checked)}
              />
              Go ahead: the commits stay on the branch.
            </label>
          </p>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Keep working
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !ready}
          onClick={onConfirm}
        >
          {busy ? (idea ? "Discarding…" : "Cancelling…") : idea ? "Discard" : "Cancel change"}
        </button>
      </div>
    </dialog>
  );
}
