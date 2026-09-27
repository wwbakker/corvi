import { type JSX } from "react";

import type { AppUpdateStatus } from "./model.ts";

/**
 * "New version available": the toast that says a check found one, in the shape the agent-ready
 * notification uses (apps/web/src/app-root/notify.tsx) — float it, click it away, or click it to
 * open the update dialog. One per remote head (apps/web/src/app-update/state.ts): the same
 * version never toasts twice, and the icon stays yellow until it is taken.
 */
export function UpdateNotice({
  status,
  visible,
  onOpen,
  onDismiss,
}: {
  status: AppUpdateStatus | null;
  visible: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}): JSX.Element | null {
  if (!visible || !status?.eligible || status.behind <= 0) return null;
  return (
    <div
      className="toast"
      role="button"
      tabIndex={0}
      // Keeps the focus where it was: the toast floats over the page, and taking the keyboard
      // away to answer it would leave the terminal behind it to click before typing again.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        onOpen();
      }}
    >
      <button
        className="toast-close"
        title="dismiss"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        ✕
      </button>
      <span className="toast-title">New version available</span>
      <span className="toast-body">
        {status.behind} new commit{status.behind === 1 ? "" : "s"} — click to update
      </span>
    </div>
  );
}
