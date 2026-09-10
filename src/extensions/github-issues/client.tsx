import { type JSX, useEffect, useRef, useState } from "react";
import { api, post } from "../../web/api.ts";
import { branchFor } from "../../shared/branch.ts";
import type { StepComponent } from "../../web/extensions.ts";
import { KEY, type GitHubIssue } from "./shared.ts";

/**
 * The github-issues extension's wizard step: the open issues of the repositories picked on the
 * step before, plus creating an issue. Picking one writes this extension's payload
 * (`extensions["github-issues"] = { repo, number }`), prefills the change id and branch, and
 * names the ticket the details step shows.
 */

type Listing = { repository?: string; issues: GitHubIssue[] };

function NewIssueDialog({
  open,
  repository,
  busy,
  onCancel,
  onCreate,
}: {
  open: boolean;
  repository: string;
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { title: string; description: string }) => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} onCancel={onCancel} onClose={onCancel}>
      <h3>New issue</h3>
      <p className="hint">
        in <code>{repository.split("/").pop()}</code>
      </p>
      <label>
        Title
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="what needs doing"
        />
      </label>
      <label>
        Description
        <textarea
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="optional"
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!title.trim() || busy}
          onClick={() => onCreate({ title, description })}
        >
          {busy ? "Creating…" : "OK"}
        </button>
      </div>
    </dialog>
  );
}

export const step: StepComponent = ({ ctx }) => {
  const [repo, setRepo] = useState<string>();
  const [listing, setListing] = useState<Listing>();
  const [selected, setSelected] = useState<GitHubIssue | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The repositories picked on the step before; the first one is the one on show.
  const paths = ctx.repos.map((r) => r.path);
  const chosen = repo && paths.includes(repo) ? repo : paths[0];

  const load = (path: string): void => {
    setLoading(true);
    setError(null);
    api<Listing>(
      `/ext/${KEY}/issues?${new URLSearchParams({
        repo: path,
        ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
      })}`,
    )
      .then(setListing)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (chosen) load(chosen);
  }, [chosen]);

  const select = (issue: GitHubIssue | null): void => {
    setSelected(issue);
    if (!chosen) return;
    ctx.setPayload(KEY, issue ? { repo: chosen, number: issue.number } : undefined);
    ctx.setTicket(issue && listing?.repository ? `${listing.repository}#${issue.number}` : undefined);
    if (issue) {
      // GitHub has no short key like PROJ-123: the issue number stands in for one, and both
      // fields stay editable on the details step.
      const key = `issue-${issue.number}`;
      ctx.setDraft({ id: key, branch: branchFor(key, issue.title) });
    }
  };

  const create = (input: { title: string; description: string }): void => {
    if (!chosen) return;
    setCreating(true);
    setError(null);
    post<{ repository: string; issue: GitHubIssue }>(`/ext/${KEY}/issues`, {
      repo: chosen,
      ...input,
    })
      .then(({ issue }) => {
        setDialogOpen(false);
        select(issue);
        load(chosen);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setCreating(false));
  };

  if (paths.length === 0) {
    return (
      <div className="issues">
        <p className="hint">
          Pick the repositories this change touches first — its GitHub issues are looked for
          there.
        </p>
      </div>
    );
  }

  return (
    <div className="issues">
      {(error || (listing && !listing.repository)) && (
        <div className="error-banner">
          {error ??
            `${(chosen ?? "").split("/").pop()} has no GitHub remote — pick another repository, or skip this step.`}
        </div>
      )}

      <button type="button" onClick={() => setDialogOpen(true)} disabled={!listing?.repository}>
        Create new issue
      </button>
      <p className="hint">
        Pick the issue this change implements, create a new one, or skip and name the change
        yourself on the details step.
      </p>

      {paths.length > 1 && (
        <div className="filters">
          <select
            value={chosen}
            onChange={(e) => {
              setSelected(null);
              setRepo(e.target.value);
            }}
          >
            {paths.map((p) => (
              <option key={p} value={p}>
                {p.split("/").pop()}
              </option>
            ))}
          </select>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Labels</th>
            <th>Assignees</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(listing?.issues ?? []).map((issue) => (
            <tr
              key={issue.number}
              className={selected?.number === issue.number ? "selected" : ""}
              onClick={() => select(selected?.number === issue.number ? null : issue)}
            >
              <td>
                <b>#{issue.number}</b> {issue.title}
              </td>
              <td>{issue.labels.join(", ") || "—"}</td>
              <td>{issue.assignees.join(", ") || "—"}</td>
              <td>
                {issue.url && (
                  <a href={issue.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    link
                  </a>
                )}
              </td>
            </tr>
          ))}
          {listing?.repository && listing.issues.length === 0 && !loading && (
            <tr>
              <td colSpan={4}>no open issues</td>
            </tr>
          )}
          {!listing && (
            <tr>
              <td colSpan={4}>{loading ? "loading…" : "—"}</td>
            </tr>
          )}
        </tbody>
      </table>

      {chosen && listing?.repository && (
        <NewIssueDialog
          open={dialogOpen}
          repository={listing.repository}
          busy={creating}
          onCancel={() => setDialogOpen(false)}
          onCreate={create}
        />
      )}
    </div>
  );
};
