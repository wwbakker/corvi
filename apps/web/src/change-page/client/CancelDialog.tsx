import { type JSX, useEffect, useRef } from "react";

/**
 * What cancelling throws away, said before it happens: the worktrees and the terminal go,
 * everything anyone else can see stays. Commits nobody else has get one acknowledge — the
 * branch survives, so they are recoverable, but only by someone who knows it is there.
 */
export function CancelDialog({
  changeId,
  idea,
  needsForce,
  acked,
  busy,
  onAck,
  onConfirm,
  onClose,
}: {
  changeId: string;
  idea: boolean;
  /** Repositories with unpushed commits, once the server has named them; empty beforehand. */
  needsForce: string[];
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
  const ready = needsForce.length === 0 || acked;

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>
        {idea ? `Discard ${changeId}?` : `Cancel ${changeId}?`}
      </h3>
      <p className="hint">
        {idea
          ? "It is archived as cancelled. Nothing was created for it."
          : "The worktrees and the terminal go. The branches, pull requests and the ticket " +
            "are left alone — you will be told what is left."}
      </p>
      {needsForce.length > 0 && (
        <p>
          <label>
            <input
              type="checkbox"
              checked={acked}
              disabled={busy}
              onChange={(e) => onAck(e.target.checked)}
            />
            {needsForce.join(", ")}: commits that were never pushed. The worktree goes, the
            branch is kept.
          </label>
        </p>
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
