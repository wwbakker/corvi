import { type JSX, useEffect, useRef } from "react";

import { StepPlan } from "../app-root/StepPlan.tsx";
import type { AppUpdateStatus } from "./model.ts";

/**
 * The update dialog: what is new, and the one button that takes it — or the reason in its place
 * (apps/web/src/app-update/update.ts decides which). While an update runs it shows the same step
 * plan a completion does, read from the journal, so a reload or a dialog reopened later lands on
 * the same truth; when one finishes, "Restart now" is the last thing it offers, because the
 * running app is the old code until then.
 */
export function UpdateDialog({
  status,
  busy,
  checking,
  error,
  canRestart,
  onClose,
  onCheck,
  onStart,
  onRestart,
}: {
  status: AppUpdateStatus | null;
  /** The update is running: no answer can be taken while it decides. */
  busy: boolean;
  checking: boolean;
  /** The last action's own failure, when it never reached the journal. */
  error: string | null;
  canRestart: boolean;
  onClose: () => void;
  onCheck: () => void;
  onStart: () => void;
  onRestart: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const progress = status?.progress ?? null;
  const behind = status?.behind ?? 0;
  const running = busy || (progress !== null && progress.finishedAt === undefined);
  const failed = progress?.error !== undefined;
  const updated = !running && status?.restartPending === true;
  const done = progress === null ? 0 : progress.steps.filter((s) => s.state === "done").length;

  const title = updated
    ? "Updated"
    : running
      ? "Updating Corvi"
      : behind > 0
        ? `Update available — ${behind} commit${behind === 1 ? "" : "s"} behind`
        : "Corvi is up to date";

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        // Escape is Close — except while the update runs, when closing the dialog is still
        // allowed (the run continues) but the question is not the update's to cancel.
        e.preventDefault();
        onClose();
      }}
    >
      <h3>{title}</h3>

      {behind > 0 && status && (
        <ul className="commits">
          {status.commits.map((commit) => (
            <li key={commit.sha}>
              {commit.url ? (
                <a href={commit.url} target="_blank" rel="noreferrer">
                  {commit.subject}
                </a>
              ) : (
                <span>{commit.subject}</span>
              )}
              <span className="sha">{commit.sha.slice(0, 7)}</span>
            </li>
          ))}
        </ul>
      )}
      {behind > 0 && status?.compareUrl && (
        <p className="hint">
          <a href={status.compareUrl} target="_blank" rel="noreferrer">
            compare on GitHub
          </a>
        </p>
      )}

      {progress !== null && (
        <>
          <StepPlan steps={progress.steps} />
          <p className="hint">
            {progress.error
              ? `stopped: ${progress.error}`
              : progress.finishedAt
                ? `updated ${progress.finishedAt.slice(0, 16).replace("T", " ")}`
                : `${done} of ${progress.steps.length}`}
          </p>
        </>
      )}
      {failed && !running && (
        <p className="hint">Everything before this step is done; running it again picks up what is left.</p>
      )}

      {updated && (
        <p className="hint">
          The new version is ready. Restart Corvi to use it
          {canRestart ? "." : ", or close and reopen the app."}
        </p>
      )}
      {!running && !updated && behind > 0 && status?.refusal && (
        <p className="hint">{status.refusal}</p>
      )}
      {error && <p className="hint error">{error}</p>}

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        {!running && !updated && behind > 0 && !status?.refusal && (
          <button type="button" className="primary" onClick={onStart} disabled={busy}>
            {busy ? "Updating…" : "Update now"}
          </button>
        )}
        {!running && !updated && behind === 0 && (
          <button type="button" className="primary" onClick={onCheck} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
        {failed && !running && (
          <button type="button" className="primary" onClick={onStart} disabled={busy}>
            {busy ? "Updating…" : "Try again"}
          </button>
        )}
        {updated && canRestart && (
          <button type="button" className="primary" onClick={onRestart}>
            Restart now
          </button>
        )}
      </div>
    </dialog>
  );
}
