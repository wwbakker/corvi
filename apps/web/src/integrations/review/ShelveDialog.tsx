import { type JSX, useEffect, useRef, useState } from "react";
import { useChangeWireClient } from "../../app-root/sources.ts";
import { ShelveResultSchema, type ShelvedFileDto, type ShelveResultDto } from "@corvi/contracts/shelves";

/** The extension's routes live under its own namespace, and the request names the workspace the
 * change belongs to, so the server's git calls inherit the right environment. */
const url = (path: string, workspace?: string): string =>
  workspace ? `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}` : path;

/** Sizes as a reader takes them in. */
export const sizeOf = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} kB`
      : `${bytes} B`;

/**
 * Shelving one repository: its uncommitted work — staged, unstaged and untracked, never ignored
 * files — put aside in the change, and the checkout left clean. A name is optional; the date is
 * the default. A patch above the warning size is asked about once, naming the biggest files,
 * because that much is usually build output that should have been ignored.
 */
export function ShelveDialog({
  changeId,
  workspace,
  repository,
  onClose,
  onShelved,
}: {
  changeId: string;
  workspace?: string;
  /** The repository's directory name in the change; null while the dialog is shut. */
  repository: string | null;
  onClose: () => void;
  /** The checkout changed: the file list and the shelves are stale. */
  onShelved: (result: ShelveResultDto) => void;
}): JSX.Element {
  const wire = useChangeWireClient();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [large, setLarge] = useState<{ patchBytes: number; largest: readonly ShelvedFileDto[] } | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const open = repository !== null;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    setName("");
    setError(null);
    setLarge(null);
  }, [repository]);

  const shelve = (allowLarge: boolean): void => {
    if (repository === null) return;
    setBusy(true);
    setError(null);
    wire
      .request("POST", url(`/ext/review/changes/${changeId}/shelves`, workspace), ShelveResultSchema, {
        body: { repository, ...(name.trim() ? { name: name.trim() } : {}), ...(allowLarge ? { allowLarge } : {}) },
      })
      .then((result) => {
        switch (result._tag) {
          case "Shelved":
          case "Clean":
            onShelved(result);
            onClose();
            return;
          case "TooLarge":
            setLarge({ patchBytes: result.patchBytes, largest: result.largest });
            return;
          case "Conflicted":
            setError(`resolve the conflicts first: ${result.files.join(", ")}`);
            return;
          case "Changed":
            setError(`${result.reason} — nothing was shelved; try again`);
            return;
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <dialog ref={ref} className="wide" onClose={onClose}>
      <h3>Shelve {repository}</h3>
      <p className="hint">
        Its uncommitted work — staged, unstaged and untracked files — is kept in the change and the
        checkout is left clean. Apply the shelf to put it back.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <input
        className="subject"
        autoFocus
        placeholder="Name (optional)"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !large) shelve(false);
        }}
      />
      {large && (
        <>
          <p>
            That is {sizeOf(large.patchBytes)} of changes — usually build output that should be
            ignored. The biggest files:
          </p>
          <ul>
            {large.largest.map((file) => (
              <li key={file.path}>
                {file.path} ({sizeOf(file.bytes)})
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => shelve(large !== null)}>
          {busy ? "Shelving…" : large ? "Shelve anyway" : "Shelve"}
        </button>
      </div>
    </dialog>
  );
}
