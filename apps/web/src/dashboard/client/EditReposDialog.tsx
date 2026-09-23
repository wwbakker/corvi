import { type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { apiClient, type Change, type RepoState, type Selection } from "../../app-root/api.ts";
import { RepoBrowser } from "../../workspace/client/RepoBrowser.tsx";

/**
 * Edits the repository list of a change as a draft: nothing is created or removed until OK.
 * Cancel throws the draft away.
 */
// Pure and synchronous: nothing for an Effect to wrap.
const sameSpec = (a: Selection, b: Selection): boolean =>
  a.location === b.location &&
  a.branch.kind === b.branch.kind &&
  (a.branch.kind === "existing" && b.branch.kind === "existing"
    ? a.branch.name === b.branch.name
    : true) &&
  (a.base ?? "") === (b.base ?? "") &&
  (a.target ?? "") === (b.target ?? "");
export function EditReposDialog({
  changeId,
  workspace,
  open,
  onClose,
  onSaved,
}: {
  changeId: string;
  /** The change's context: where its repository browser opens. */
  workspace?: string;
  open: boolean;
  onClose: () => void;
  onSaved: (change: Change) => void;
}): JSX.Element {
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
    apiClient
      .repoStates(ChangeId.make(changeId))
      .then((repos) => {
        setCurrent(repos);
        setDraft(
          repos.map((r) => ({
            path: r.path,
            location: r.location,
            branch: r.branch,
            base: r.base,
            target: r.target,
          })),
        );
      })
      .catch((e: Error) => setError(e.message));
  }, [open, changeId]);

  const save = (force = false): void => {
    setBusy(true);
    setError(null);
    apiClient
      .setRepositories(ChangeId.make(changeId), { checkouts: draft, force })
      .then(onSaved)
      .catch((e: unknown) => {
        const needsForce = (e as { body?: { needsForce?: string[] } }).body?.needsForce;
        // Work worth a look before it goes: ask once, then repeat the same edit with force.
        if (needsForce?.length) {
          if (
            window.confirm(
              `${needsForce.join(", ")}: uncommitted changes or commits that were never pushed. ` +
                `A worktree goes, its branch stays unless its work landed; a checkout used where ` +
                `it is, is left exactly as it is. Nothing in the source repository is deleted. Continue?`,
            )
          ) {
            save(true);
            return;
          }
          setError(null);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };

  const has = (path: string): boolean => draft.some((d) => d.path === path);
  const dropped = current.filter((r) => !has(r.path));
  // A repository whose spec changed counts as added: it is set up again the new way.
  const added = draft.filter(
    (d) => !current.some((r) => r.path === d.path && sameSpec(r, d)),
  );

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>Repositories</h3>
      {error && <div className="error-banner">{error}</div>}
      <RepoBrowser
        workspace={workspace}
        selected={draft}
        onAdd={(path) =>
          setDraft(has(path) ? draft : [...draft, { path, location: "new", branch: { kind: "change" } }])
        }
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
