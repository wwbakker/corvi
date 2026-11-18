import { type JSX, useEffect, useRef } from "react";

import type { HostStatusDto } from "@corvi/contracts/api";

import { hostMismatchDetail, hostSessionsSentence } from "./hostRestart.ts";

/**
 * The question a stale terminal host asks: what differs, what a restart would end, and the two
 * answers. It is asked because the server keeps the host otherwise — one click here is the only way
 * a replacement happens, so the cost of a stray click is somebody's running agent.
 *
 * The hosts it describes live in `hostRestart.ts`; this component only draws the answer.
 */
export function HostRestartDialog({
  status,
  busy,
  error,
  onClose,
  onRestart,
}: {
  status: HostStatusDto;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRestart: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        // Escape is Not now, and it stays available while the restart runs: the run continues, and
        // the page shows where it got to.
        event.preventDefault();
        onClose();
      }}
    >
      <h3>Restart the terminal host</h3>

      {status.identity !== null && (
        <p className="hint">
          This server is using a terminal host it did not start. A restart ends every shell, agent and action
          run inside the old one — its windows come back empty.
        </p>
      )}

      <ul className="host-mismatches">
        {status.stale.map((mismatch) => (
          <li key={mismatch.kind}>{hostMismatchDetail(mismatch)}</li>
        ))}
      </ul>

      {status.sessions !== undefined && <p className="hint">{hostSessionsSentence(status.sessions)}</p>}

      {error !== null && <p className="hint error">{error}</p>}

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Not now
        </button>
        <button type="button" className="primary" onClick={onRestart} disabled={busy}>
          {busy ? "Restarting…" : "Restart the terminal host"}
        </button>
      </div>
    </dialog>
  );
}
