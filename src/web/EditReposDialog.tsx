import { useEffect, useRef, useState } from "react";
import { api, post, type ApiError, type Change, type RepoState, type Selection } from "./api.ts";
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
  const [draft, setDraft] = useState<Selection[]>([]);
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
        setDraft(repos.map((r) => ({ path: r.path, direct: r.direct, base: r.base })));
      })
      .catch((e: Error) => setError(e.message));
  }, [open, changeId]);

  const save = (force = false) => {
    setBusy(true);
    setError(null);
    post<Change>(`/changes/${changeId}/repos`, {
      repos: draft.map((d) => d.path),
      direct: draft.filter((d) => d.direct).map((d) => d.path),
      base: Object.fromEntries(draft.filter((d) => d.base).map((d) => [d.path, d.base!])),
      force,
    })
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

  const has = (path: string): boolean => draft.some((d) => d.path === path);
  const dropped = current.filter((r) => !has(r.path));
  // A repository whose mode changed counts as added: it is set up again the other way.
  const added = draft.filter(
    (d) => !current.some((r) => r.path === d.path && r.direct === d.direct),
  );

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>Repositories</h3>
      {error && <div className="error-banner">{error}</div>}
      <RepoBrowser
        selected={draft}
        onAdd={(path) => setDraft(has(path) ? draft : [...draft, { path, direct: false }])}
        onRemove={(path) => setDraft(draft.filter((d) => d.path !== path))}
        onChange={(path, patch) =>
          setDraft(draft.map((d) => (d.path === path ? { ...d, ...patch } : d)))
        }
      />
      <p className="hint">
        {added.length || dropped.length
          ? `${added.length} to add, ${dropped.length} to remove` +
            (draft.length === 0 ? " — leaving the change with none, which you can add back" : "") +
            (dropped.some((r) => r.unsafe)
              ? ` — ${dropped
                  .filter((r) => r.unsafe)
                  .map((r) => `${r.name} has ${r.unsafe!.text}`)
                  .join(", ")}`
              : "")
          : "No changes yet: worktrees and links are created and removed when you press OK."}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          // Emptying the list is allowed: removing a repository and adding it back is how you
          // get a fresh worktree, and that has an empty moment in the middle.
          disabled={busy || (!added.length && !dropped.length)}
          onClick={() => save()}
        >
          {busy ? "Applying…" : "OK"}
        </button>
      </div>
    </dialog>
  );
}
