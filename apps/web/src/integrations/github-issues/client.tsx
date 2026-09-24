import { type JSX, useEffect, useRef, useState } from "react";
import { makeWireClient } from "@corvi/client";
import { Schema } from "effect";
import { ChangeWireSchema } from "@corvi/contracts/api";
import { branchFor, repoPathsOf } from "../../domain/change.ts";
import type { EditComponent, StepComponent } from "../client.tsx";
import {
  GitHubIssueSchema,
  KEY,
  type GitHubIssue,
  type IssueRef,
} from "@corvi/contracts/integrations/github-issues";

/**
 * The github-issues extension's two screens: the wizard's step — the open issues of the
 * repositories picked beside it, plus creating one — and the GitHub issues card's
 * editor, which is the same picker pointed at the link of an existing change. Picking one in
 * the wizard writes this extension's payload (`extensions["github-issues"] = { repo, number }`),
 * prefills the change id and branch, and names the ticket the details step shows; picking one
 * in the editor replaces that payload through the link route.
 */

type Listing = { repository?: string; issues: GitHubIssue[] };

/** A picked issue, with where it lives: the source path the caller cares about, and the
 * `owner/name` the listing named, for the labels that say which issue this is. */
type Picked = { repo: string; repository?: string; issue: GitHubIssue };

/** The transport: the page's classified `ClientError`, with this extension's own DTOs. */
const wire = makeWireClient({ baseUrl: "" });
const ListingSchema = Schema.Struct({
  repository: Schema.optional(Schema.String),
  issues: Schema.mutable(Schema.Array(GitHubIssueSchema)),
});
const CreatedIssueSchema = Schema.Struct({
  repository: Schema.String,
  issue: GitHubIssueSchema,
});

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

/**
 * The picker: one repository's open issues, and creating one. The wizard's step and the card's
 * editor both use it. The repository and the selection belong to the caller — the wizard writes
 * its payload with them, the editor holds its draft — while the listing and the create dialog
 * live here.
 */
function IssuePicker({
  paths,
  workspace,
  repo,
  onRepoChange,
  selected,
  onSelect,
  hint,
  noRepositories,
}: {
  /** Where GitHub issues are looked for: the change's repositories. */
  paths: string[];
  /** Whose GitHub: a second client is a second account. */
  workspace?: string;
  /** Which repository's issues are on show; the first when unset or no longer listed. */
  repo: string | undefined;
  onRepoChange: (path: string) => void;
  /** The number of the picked issue, for the row highlight. */
  selected: number | null;
  onSelect: (picked: Picked | null) => void;
  /** What to say under the create button: the wizard's field is not the editor's. */
  hint?: string;
  /** What to say when there are no repositories to look in. */
  noRepositories?: string;
}): JSX.Element {
  const [listing, setListing] = useState<Listing>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = repo && paths.includes(repo) ? repo : paths[0];

  const load = (path: string): void => {
    setLoading(true);
    setError(null);
    wire
      .request(
        "GET",
        `/ext/${KEY}/issues?${new URLSearchParams({
          repo: path,
          ...(workspace ? { workspace } : {}),
        })}`,
        ListingSchema,
      )
      .then(setListing)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (chosen) load(chosen);
  }, [chosen]);

  const select = (issue: GitHubIssue | null): void =>
    onSelect(issue && chosen ? { repo: chosen, repository: listing?.repository, issue } : null);

  const create = (input: { title: string; description: string }): void => {
    if (!chosen) return;
    setCreating(true);
    setError(null);
    wire
      .request("POST", `/ext/${KEY}/issues`, CreatedIssueSchema, { body: { repo: chosen, ...input } })
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
          {noRepositories ??
            "Pick the repositories this change touches first — its GitHub issues are looked for there."}
        </p>
      </div>
    );
  }

  return (
    <div className="issues">
      {(error || (listing && !listing.repository)) && (
        <div className="error-banner">
          {error ??
            `${(chosen ?? "").split("/").pop()} has no GitHub remote — pick another repository.`}
        </div>
      )}

      <button type="button" onClick={() => setDialogOpen(true)} disabled={!listing?.repository}>
        Create new issue
      </button>
      <p className="hint">{hint}</p>

      {paths.length > 1 && (
        <div className="filters">
          <select
            value={chosen}
            onChange={(e) => {
              onSelect(null);
              onRepoChange(e.target.value);
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
              className={selected === issue.number ? "selected" : ""}
              onClick={() => select(selected === issue.number ? null : issue)}
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
}

export const step: StepComponent = ({ ctx }) => {
  // The payload is the step's own memory: the repository and the issue number it picked, read
  // back when the wizard is reopened. The issue list is asked again, so the number is enough to
  // find the row again.
  const stored = ctx.payload(KEY) as { repo?: string; number?: number } | undefined;
  const [repo, setRepo] = useState<string | undefined>(stored?.repo);
  const [selected, setSelected] = useState<number | null>(stored?.number ?? null);

  // The repositories picked on the step before; the first one is the one on show.
  const paths = ctx.repos.map((r) => r.path);

  const select = (picked: Picked | null): void => {
    setSelected(picked?.issue.number ?? null);
    if (!picked) {
      ctx.setPayload(KEY, undefined);
      ctx.setPick(KEY, undefined);
      return;
    }
    ctx.setPayload(KEY, { repo: picked.repo, number: picked.issue.number });
    // The field shows the issue's URL number under its repository; its title is the name that
    // may name the change.
    ctx.setPick(KEY, {
      label: picked.repository
        ? `${picked.repository}#${picked.issue.number}`
        : `#${picked.issue.number}`,
      name: picked.issue.title,
    });
    // GitHub has no short key like PROJ-123: the issue number stands in for one, and the id and
    // branch stay editable.
    const key = `issue-${picked.issue.number}`;
    ctx.setDraft({ id: key, branch: branchFor(key, picked.issue.title) });
  };

  return (
    <IssuePicker
      paths={paths}
      workspace={ctx.workspace}
      repo={repo}
      onRepoChange={setRepo}
      selected={selected}
      onSelect={select}
      hint="Pick the issue this change implements, create a new one, or skip and name the change yourself on the next step."
    />
  );
};

/**
 * The GitHub issues card's editor: the picker again, repointing a live change at another issue.
 * The save is this extension's own route; what the change's completion later closes follows the
 * new ref, and the old issue is left where it is.
 */
export const edit: EditComponent = ({ change, workspace, open, onClose, onSaved }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const current = change.extensions?.[KEY] as IssueRef | undefined;
  // The pick in the dialog — null while nothing new is picked. The current link stays marked
  // (the picker falls back to its number) but is not a pick, so OK stays shut until the link
  // really changes.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [repo, setRepo] = useState<string | undefined>(current?.repo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker looks in the change's repositories; a link whose repository is no longer one of
  // them is still offered, so the current link is visible and replaceable.
  const paths = [...new Set([...repoPathsOf(change), ...(current?.repo ? [current.repo] : [])])];

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // A fresh question every time it opens: Cancel throws the draft away.
      setPicked(null);
      setRepo(current?.repo);
      setError(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const changed: boolean =
    picked !== null && (picked.repo !== current?.repo || picked.issue.number !== current?.number);

  const save = (): void => {
    if (!picked || !changed) return;
    setBusy(true);
    setError(null);
    wire
      .request(
        "PUT",
        `/ext/${KEY}/changes/${encodeURIComponent(change.id)}/link`,
        ChangeWireSchema,
        { body: { repo: picked.repo, number: picked.issue.number } },
      )
      .then((updated) => {
        setPicked(null);
        onClose();
        onSaved(updated);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <dialog ref={ref} className="wide" onCancel={onClose} onClose={onClose}>
      <h3>GitHub issue link</h3>
      {error && <div className="error-banner">{error}</div>}
      <IssuePicker
        paths={paths}
        workspace={workspace}
        repo={repo}
        onRepoChange={setRepo}
        selected={picked?.issue.number ?? current?.number ?? null}
        onSelect={setPicked}
        hint="Pick the issue this change is about."
        noRepositories="This change has no repositories to look for issues in."
      />
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!changed || busy} onClick={save}>
          {busy ? "Linking…" : "OK"}
        </button>
      </div>
    </dialog>
  );
};
