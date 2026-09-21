import { type JSX, useEffect, useRef, useState } from "react";
import { type CompletionReason, type CompletionRefusal } from "../../app-root/api.ts";

/** Whether "Complete anyway" may run: every reason acknowledged, and none of them hard.
 * Pure so the test pins the gating without clicking. */
// Pure and synchronous: nothing for an Effect to wrap.
export function canCompleteAnyway(reasons: CompletionReason[], acked: boolean[]): boolean {
  return (
    reasons.length > 0 &&
    acked.every(Boolean) &&
    reasons.every((r) => r.kind !== "hard")
  );
}

/**
 * What completing anyway waives: every unmet requirement, one acknowledge each. Nothing is
 * done until "Complete anyway" — Cancel throws the draft away, like the repositories dialog.
 */
export function CompleteAnywayDialog({
  changeId,
  refusal,
  busy,
  onComplete,
  onClose,
}: {
  changeId: string;
  refusal: CompletionRefusal;
  /** A forced completion already in flight: the buttons wait for it, not for the dialog. */
  busy: boolean;
  /** Every reason acknowledged: run the forced completion. */
  onComplete: () => void;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  // One acknowledge per reason, reset every time the dialog opens for a new refusal.
  const [acked, setAcked] = useState<boolean[]>([]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    setAcked(refusal.reasons.map(() => false));
  }, [refusal]);

  // Hard reasons refuse outright, even with force: uncommitted work exists nowhere else, and
  // an idea is left by starting, not by completing. The dialog then says why rather than
  // offering a button that cannot work.
  const hard = refusal.reasons.filter((r) => r.kind === "hard");
  const allAcked = canCompleteAnyway(refusal.reasons, acked);

  const toggle = (index: number): void =>
    setAcked(acked.map((a, i) => (i === index ? !a : a)));

  const describe = (reason: CompletionReason): string =>
    reason.kind === "hard"
      ? `${reason.text} — this cannot be overridden`
      : reason.text;

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>Complete {changeId} anyway?</h3>
      <p className="hint">
        {hard.length > 0
          ? "These requirements cannot be overridden. Resolve them first, then complete."
          : "The change is not ready to complete. Acknowledging each requirement completes " +
            "the change without it: pull requests that are not merged stay unmerged, and " +
            "unpushed commits stay on the branch."}
      </p>
      {refusal.toMerge.length > 0 && (
        <p className="hint">
          These pull requests will still be merged:{" "}
          {refusal.toMerge.map(({ repo, number }) => `#${number} ${repo.split("/").pop()}`).join(", ")}.
        </p>
      )}
      <ul className="override-reasons">
        {refusal.reasons.map((reason, i) => (
          <li key={`${reason.text}-${i}`}>
            <label>
              <input
                type="checkbox"
                checked={acked[i] ?? false}
                disabled={busy || reason.kind === "hard"}
                onChange={() => toggle(i)}
              />
              {describe(reason)}
            </label>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {hard.length === 0 && (
          <button
            type="button"
            className="primary"
            disabled={busy || !allAcked}
            onClick={onComplete}
          >
            {busy ? "Completing…" : "Complete anyway"}
          </button>
        )}
      </div>
    </dialog>
  );
}
