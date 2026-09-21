import { type JSX, useEffect, useRef, useState } from "react";
import { makeWireClient } from "@corvi/client";
import { Schema } from "effect";
import { CommitResultSchema, type CommitResult, type FileChange } from "./shared.ts";

/** The transport: the page's classified `ClientError`, with this extension's own DTOs. */
const wire = makeWireClient({ baseUrl: "" });
const commitResultsSchema = Schema.mutable(Schema.Array(CommitResultSchema));

/** What the dialog is offered: the repositories with something in them, and their files. */
export type Candidate = { repo: string; name: string; files: FileChange[] };

const key = (repo: string, path: string): string => `${repo}\u0000${path}`;

/** The extension's routes live under its own namespace, and the request names the workspace the
 * change belongs to, so the server's git calls inherit the right environment. */
const url = (path: string, workspace?: string): string =>
  workspace ? `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}` : path;

/**
 * Committing, across the repositories of a change at once.
 *
 * One message for all of them, because a change is one piece of work and which repository a
 * file lives in is where the code happens to be kept. Each repository still gets its own commit,
 * since that is what git offers.
 *
 * What is ticked is what is committed — `git add` then `git commit` with the paths spelled out,
 * so anything else you had staged is left staged. Nothing here stages or unstages behind your
 * back: the tick is the whole decision, and it is visible.
 */
export function CommitDialog({
  changeId,
  workspace,
  open,
  candidates,
  suggestion,
  onClose,
  onCommitted,
}: {
  changeId: string;
  workspace?: string;
  open: boolean;
  candidates: Candidate[];
  /** What to start the message with — the change and what it is about. */
  suggestion: string;
  onClose: () => void;
  /** Something was committed: the file lists are stale. */
  onCommitted: (results: CommitResult[]) => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CommitResult[] | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    // Every opening starts fresh: from what is staged, or from everything when nothing is.
    setError(null);
    setResults(null);
    setMessage(suggestion);
    const staged = candidates.flatMap((c) =>
      c.files.filter((f) => f.staged).map((f) => key(c.repo, f.path)),
    );
    setPicked(
      new Set(
        staged.length > 0
          ? staged
          : candidates.flatMap((c) => c.files.map((f) => key(c.repo, f.path))),
      ),
    );
  }, [open]);

  const toggle = (repo: string, path: string): void =>
    setPicked((current) => {
      const next = new Set(current);
      const id = key(repo, path);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const commit = (): void => {
    setBusy(true);
    setError(null);
    const files = Object.fromEntries(
      candidates.map((c) => [
        c.repo,
        c.files.map((f) => f.path).filter((path) => picked.has(key(c.repo, path))),
      ]),
    );
    wire
      .request("POST", url(`/ext/review/changes/${changeId}/commit`, workspace), commitResultsSchema, {
        body: { message, files },
      })
      .then((next) => {
        setResults(next);
        onCommitted(next);
        // Everything went in: there is nothing left to look at.
        if (next.every((r) => r.ok)) onClose();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const count = picked.size;

  return (
    <dialog ref={ref} className="wide" onClose={onClose}>
      <h3>Commit</h3>
      {error && <div className="error-banner">{error}</div>}

      <textarea
        className="message"
        rows={3}
        autoFocus
        placeholder="What this commit does"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <div className="commit-files">
        {candidates.map((c) => (
          <div key={c.repo} className="group">
            <h4>{c.name}</h4>
            {c.files.map((f) => (
              <label key={f.path} className="commit-file">
                <input
                  type="checkbox"
                  checked={picked.has(key(c.repo, f.path))}
                  onChange={() => toggle(c.repo, f.path)}
                />
                <span className="name">{f.path}</span>
                {/* Staged or not is git's business and yours; it changes nothing here, but a
                    file you had staged is one you had already decided about. */}
                {f.staged && <span className="tag">staged</span>}
              </label>
            ))}
          </div>
        ))}
      </div>

      {/* Only the failures survive the dialog closing: a repository that refused says why. */}
      {results?.some((r) => !r.ok) && (
        <div className="results">
          {results.map((r) => (
            <p key={r.repo} className={r.ok ? "hint" : "error-text"}>
              {r.name}: {r.ok ? `committed ${r.hash}` : r.error}
            </p>
          ))}
        </div>
      )}

      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="create" disabled={busy || count === 0 || !message.trim()} onClick={commit}>
          {busy ? "Committing…" : `Commit ${count} file${count === 1 ? "" : "s"}`}
        </button>
      </div>
    </dialog>
  );
}
