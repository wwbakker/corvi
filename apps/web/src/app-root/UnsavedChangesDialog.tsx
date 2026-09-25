import { type JSX, useEffect, useRef } from "react";

/**
 * What happens to the edits that are not written yet, said before anything happens to them.
 * The draft stays where it is until one of the three answers: save it on the way out, leave it
 * behind, or stay — which is also Escape. Saving runs the page's own save, so its failure is
 * the page's own: this dialog closes and the page explains.
 *
 * The shell's dialog, shared by every guarded page (docs/decisions/unsaved-changes.md); what is
 * unsaved is the page's to name, so the subject comes with the guard it speaks of.
 */
export function UnsavedChangesDialog({
  subject,
  busy,
  onSaveAndLeave,
  onDiscardAndLeave,
  onStay,
}: {
  /** What is unsaved, in the page's own words ("Unsaved settings", "Unsaved changes to x.md"). */
  subject: string;
  /** The save is running: no answer can be taken back while it decides. */
  busy: boolean;
  onSaveAndLeave: () => void;
  onDiscardAndLeave: () => void;
  onStay: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        // Escape is Stay — except while the save runs, when there is nothing to take back yet.
        if (busy) e.preventDefault();
        else onStay();
      }}
    >
      <h3>{subject}</h3>
      <p className="hint">
        The edits are not written to the file yet. Save them on the way out, leave them behind,
        or stay here.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onStay} disabled={busy}>
          Stay
        </button>
        <button type="button" className="danger" onClick={onDiscardAndLeave} disabled={busy}>
          Discard and leave
        </button>
        <button type="button" className="primary" onClick={onSaveAndLeave} disabled={busy}>
          {busy ? "Saving…" : "Save and leave"}
        </button>
      </div>
    </dialog>
  );
}
