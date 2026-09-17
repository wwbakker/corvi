import { type JSX, useEffect, useRef, useState } from "react";
import type { Listing } from "../../app-root/api.ts";
import { DirectoryListing } from "./DirectoryListing.tsx";
import { fetchListing } from "./repoListing.ts";

/**
 * Modal directory chooser for the settings page: the same listing the repository browser shows,
 * with the directory on screen as the choice rather than a row action on every row.
 *
 * It opens on the field's own value when it has one, and otherwise on the repositories directory
 * the server resolves for the workspace — so an empty field first shows the place browsing would
 * start anyway, which is usually the one to extend.
 */
export function DirectoryPicker({
  open,
  onClose,
  onChoose,
  path,
  workspace,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (path: string) => void;
  /** The field's value: where to open. The server expands `~` and rejects anything relative. */
  path?: string;
  /** Which context's repositories directory to open on when the field is empty. */
  workspace?: string;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<Listing>();
  const [error, setError] = useState<string>();
  // The server withholds dot-directories, so this is part of the request, not a filter.
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const list = (dir: string | undefined, hidden: boolean): void => {
    setError(undefined);
    fetchListing({ path: dir, workspace, hidden })
      .then(setListing)
      .catch((e: Error) => setError(e.message));
  };

  // Opened: fetch where it should start. An explicit path wins; otherwise the workspace's
  // repositories directory, which is what the browser would open on too. Each opening starts
  // with hidden directories off, so a fresh choice is not coloured by the last one.
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setListing(undefined);
    setShowHidden(false);
    list(path, false);
  }, [open, path, workspace]);

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>Choose a directory</h3>
      {error && <div className="error-banner">{error}</div>}
      {listing ? (
        <>
          <DirectoryListing
            listing={listing}
            onOpen={(dir) => list(dir, showHidden)}
            showHidden={showHidden}
            onShowHidden={(next) => {
              setShowHidden(next);
              list(listing.path, next);
            }}
          />
          <p className="hint">
            Choosing sets the field to <code>{listing.path}</code>.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onChoose(listing.path);
                onClose();
              }}
            >
              Use this directory
            </button>
          </div>
        </>
      ) : (
        !error && <p className="hint">loading…</p>
      )}
    </dialog>
  );
}
