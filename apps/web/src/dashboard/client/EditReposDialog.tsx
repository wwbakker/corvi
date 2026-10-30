import { type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import {
  type Change,
  type ProvisionResult,
  type RepoState,
  type Selection,
} from "../../app-root/api.ts";
import { useChangeClient } from "../../app-root/sources.ts";
import { RepoBrowser } from "../../workspace/client/RepoBrowser.tsx";
import { forceQuestion } from "../../change-page/client/refusals.ts";

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
  onSaved: (change: Change, provision?: readonly ProvisionResult[]) => void;
}): JSX.Element {
  const client = useChangeClient();
  const ref = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<RepoState[]>([]);
  const [draft, setDraft] = useState<Selection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server's force question, once an OK has met work the edit would discard: one line per
  // reason, and one acknowledge before the same edit is repeated with force.
  const [question, setQuestion] = useState<string[] | null>(null);
  const [acked, setAcked] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    // Start from what the change has now, every time the dialog is opened.
    setError(null);
    setQuestion(null);
    client
      .changes.repoStates(ChangeId.make(changeId))
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
    client
      .changes.setRepositories(ChangeId.make(changeId), { checkouts: draft, force })
      // The edit applies and the dialog closes; what the checkouts then reported goes to the
      // dashboard's banner, and a failed row offers its own action as the retry.
      .then((saved) => onSaved(saved.change, saved.provision))
      .catch((e: unknown) => {
        // Work worth a look before it goes: asked here, then the same edit repeats with force.
        const asked = forceQuestion(e);
        if (asked) {
          setQuestion(asked);
          setAcked(false);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };

  /** A different edit is a different question: the answer given was about the old one. */
  const edit = (next: Selection[]): void => {
    setDraft(next);
    setQuestion(null);
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
        client={client}
        selected={draft}
        onAdd={(path) =>
          edit(has(path) ? draft : [...draft, { path, location: "new", branch: { kind: "change" } }])
        }
        onRemove={(path) => edit(draft.filter((d) => d.path !== path))}
        onChange={(path, patch) => edit(draft.map((d) => (d.path === path ? { ...d, ...patch } : d)))}
      />
      <p className="hint">
        {added.length || dropped.length
          ? `${added.length} to add, ${dropped.length} to remove` +
            (draft.length === 0 ? " — leaving the change with none, which you can add back" : "") +
            // Said once: the question below names the same work once the server has asked it.
            (question === null && dropped.some((r) => r.unsafe)
              ? ` — ${dropped
                  .filter((r) => r.unsafe)
                  .map((r) => `${r.name} has ${r.unsafe!.text}`)
                  .join(", ")}`
              : "")
          : "No changes yet: worktrees and links are created and removed when you press OK."}
      </p>
      {question && (
        <>
          <ul>
            {question.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            <label className="ack">
              <input
                type="checkbox"
                checked={acked}
                disabled={busy}
                onChange={(e) => setAcked(e.target.checked)}
              />
              Remove anyway: a worktree goes with its untracked files and its branch stays unless
              its work landed; a checkout used where it is, is left as it is.
            </label>
          </p>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          // Emptying the list is allowed: removing a repository and adding it back is how you
          // get a fresh worktree, and that has an empty moment in the middle.
          disabled={busy || (!added.length && !dropped.length) || (question !== null && !acked)}
          onClick={() => save(question !== null)}
        >
          {busy ? "Applying…" : "OK"}
        </button>
      </div>
    </dialog>
  );
}
