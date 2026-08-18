import { useEffect, useRef, useState } from "react";
import { api, post, type ApiError, type Change, type RepoState } from "./api.ts";
import { RepoBrowser } from "./RepoBrowser.tsx";

/**
 * Edits the repository list of a change as a draft: nothing is created or removed until OK.
 * Cancel throws the draft away.
 */
export function EditReposDialog({
  changeId,
  open,
  onClose,
  onSaved,
}: {
  changeId: string;
  open: boolean;
  onClose: () => void;
  onSaved: (change: Change) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<RepoState[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    // Start from what the change has now, every time the dialog is opened.
    setError(null);
    api<RepoState[]>(`/changes/${changeId}/repos`)
      .then((repos) => {
        setCurrent(repos);
        setDraft(repos.map((r) => r.path));
      })
      .catch((e: Error) => setError(e.message));
  }, [open, changeId]);

  const save = (force = false) => {
    setBusy(true);
    setError(null);
    post<Change>(`/changes/${changeId}/repos`, { repos: draft, force })
      .then(onSaved)
      .catch((e: ApiError) => {
        const needsForce = (e.body as { needsForce?: string[] })?.needsForce;
        // Unpushed commits: ask once, then repeat the same edit with force.
        if (needsForce?.length) {
          if (
            window.confirm(
              `${needsForce.join(", ")}: commits that were never pushed. ` +
                `The worktree goes, the branch is kept. Continue?`,
            )
          ) {
            save(true);
            return;
          }
          setError(null);
          return;
        }
        setError(e.message);
      })
      .finally(() => setBusy(false));
  };

  const dropped = current.filter((r) => !draft.includes(r.path));
  const added = draft.filter((path) => !current.some((r) => r.path === path));

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>Repositories</h3>
      {error && <div className="error-banner">{error}</div>}
      <RepoBrowser
        selected={draft}
        onAdd={(path) => setDraft(draft.includes(path) ? draft : [...draft, path])}
        onRemove={(path) => setDraft(draft.filter((p) => p !== path))}
      />
      <p className="hint">
        {added.length || dropped.length
          ? `${added.length} to add, ${dropped.length} to remove` +
            (dropped.some((r) => r.unsafe)
              ? ` — ${dropped
                  .filter((r) => r.unsafe)
                  .map((r) => `${r.name} has ${r.unsafe!.text}`)
                  .join(", ")}`
              : "")
          : "No changes yet: worktrees are created and removed when you press OK."}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || draft.length === 0 || (!added.length && !dropped.length)}
          onClick={() => save()}
        >
          {busy ? "Applying…" : "OK"}
        </button>
      </div>
    </dialog>
  );
}
