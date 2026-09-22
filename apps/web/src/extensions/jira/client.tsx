import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { makeWireClient } from "@corvi/client";
import { branchFor } from "../../domain/change.ts";
import type { StepComponent } from "../../integrations/client.tsx";
import { BoardSchema, IssueSchema, type Board, type Issue } from "@corvi/contracts/integrations/jira";

/** The transport: the page's classified `ClientError`, with this extension's own DTOs. */
const wire = makeWireClient({ baseUrl: "" });

/**
 * The jira extension's wizard step: the board, filtered and grouped, plus creating an issue.
 * Picking one writes this extension's payload (`extensions.jira = { key }`), prefills the
 * change id and branch, and names the ticket the details step shows.
 */

/** Native <dialog>: modal behaviour, focus trap and Escape come from the platform. */
function NewIssueDialog({
  open,
  busy,
  onCancel,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { summary: string; description: string }) => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [summary, setSummary] = useState("");
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
      <label>
        Title
        <input
          autoFocus
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
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
          disabled={!summary.trim() || busy}
          onClick={() => onCreate({ summary, description })}
        >
          {busy ? "Creating…" : "OK"}
        </button>
      </div>
    </dialog>
  );
}

/** Assignees Z-A with the unassigned last, then status, then key: the people axis first,
 * because that is how you scan a board. */
const byAssignee = (a: string, b: string): number =>
  !a && !b ? 0 : !a ? 1 : !b ? -1 : b.localeCompare(a);

const bySprintOrder = (a: Issue, b: Issue): number =>
  byAssignee(a.assignee, b.assignee) ||
  a.status.localeCompare(b.status) ||
  a.key.localeCompare(b.key, undefined, { numeric: true });

/** Board issues with client-side filtering: the whole board is a few hundred rows, so filtering
 * in the browser is instant and costs no round trip. ponytail: move to JQL if the board grows. */
export function IssueTable({
  workspace,
  selectedKey,
  onSelect,
}: {
  /** Whose Jira: a second client is a second site, and its board is not this one's. */
  workspace?: string;
  /** The key of the picked issue rather than the issue itself: the board is asked again when a
   * draft is reopened, and the row that was picked is found by its key. */
  selectedKey: string | null;
  onSelect: (issue: Issue | null) => void;
}): JSX.Element {
  const [board, setBoard] = useState<Board>({ issues: [], sprints: [] });
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState("");
  const [sprint, setSprint] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (refresh = false): void => {
    setLoading(true);
    wire
      .request(
        "GET",
        `/ext/jira/issues?${new URLSearchParams({
          ...(workspace ? { workspace } : {}),
          ...(refresh ? { refresh: "1" } : {}),
        })}`,
        BoardSchema,
      )
      .then(setBoard)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const assignees = useMemo(
    () => [...new Set(board.issues.map((i) => i.assignee).filter(Boolean))].sort(byAssignee),
    [board.issues],
  );

  /** Groups in board order (open sprints as reported by Jira, backlog last), filters applied. */
  const groups = useMemo(() => {
    const needle = text.toLowerCase();
    const rows = board.issues.filter(
      (i) =>
        (!needle || `${i.key} ${i.summary}`.toLowerCase().includes(needle)) &&
        (!assignee || i.assignee === assignee) &&
        (!sprint || (sprint === "(backlog)" ? !i.sprint : i.sprint === sprint)),
    );
    return [...board.sprints, ""]
      .map((name) => ({
        name,
        label: name || "Backlog",
        issues: rows.filter((i) => i.sprint === name).sort(bySprintOrder),
      }))
      .filter((g) => g.issues.length > 0);
  }, [board, text, assignee, sprint]);

  const create = (input: { summary: string; description: string }): void => {
    setCreating(true);
    setError(null);
    wire
      .request("POST", "/ext/jira/issues", IssueSchema, { body: { ...input, workspace } })
      .then((issue) => {
        setDialogOpen(false);
        onSelect(issue);
        load(true);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setCreating(false));
  };

  return (
    <div className="issues">
      {(error || board.error) && <div className="error-banner">{error ?? board.error}</div>}

      <button type="button" onClick={() => setDialogOpen(true)}>
        Create new issue
      </button>
      <p className="hint">
        Pick the issue this change implements, create a new one, or skip and name the change
        yourself on the next step.
      </p>

      <div className="filters">
        <input
          placeholder="filter by key or summary"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">all assignees</option>
          {assignees.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={sprint} onChange={(e) => setSprint(e.target.value)}>
          <option value="">all sprints</option>
          {board.sprints.map((s) => (
            <option key={s}>{s}</option>
          ))}
          <option>(backlog)</option>
        </select>
        <button type="button" onClick={() => load(true)} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Summary</th>
            <th>Assignee</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        {groups.map((group) => {
          const isCollapsed = collapsed.includes(group.name);
          return (
            <tbody key={group.label}>
              <tr
                className="group"
                onClick={() =>
                  setCollapsed(
                    isCollapsed
                      ? collapsed.filter((n) => n !== group.name)
                      : [...collapsed, group.name],
                  )
                }
              >
                <th colSpan={5}>
                  {isCollapsed ? "▸" : "▾"} {group.label}
                  <span className="count">{group.issues.length}</span>
                </th>
              </tr>
              {!isCollapsed &&
                group.issues.map((issue) => (
                  <tr
                    key={issue.key}
                    className={issue.key === selectedKey ? "selected" : ""}
                    onClick={() => onSelect(issue.key === selectedKey ? null : issue)}
                  >
                    <td>{issue.key}</td>
                    <td className="summary">{issue.summary}</td>
                    <td>{issue.assignee || "—"}</td>
                    <td>{issue.status}</td>
                    <td>
                      {board.baseUrl && (
                        <a
                          href={`${board.baseUrl}/browse/${issue.key}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()} // opening Jira must not also select
                        >
                          link
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          );
        })}
        {groups.length === 0 && !loading && (
          <tbody>
            <tr>
              <td colSpan={5}>no issues match</td>
            </tr>
          </tbody>
        )}
      </table>

      <NewIssueDialog
        open={dialogOpen}
        busy={creating}
        onCancel={() => setDialogOpen(false)}
        onCreate={create}
      />
    </div>
  );
}

/** The step, as the wizard's host renders it. */
export const step: StepComponent = ({ ctx }) => {
  // The selection is the payload's own key, not an issue object: the board is asked again when
  // the wizard is reopened, so the step keeps what it picked and the table finds the row.
  const stored = ctx.payload("jira") as { key?: string } | undefined;
  const [selectedKey, setSelectedKey] = useState<string | null>(stored?.key ?? null);

  const select = (issue: Issue | null): void => {
    setSelectedKey(issue?.key ?? null);
    ctx.setPayload("jira", issue ? { key: issue.key } : undefined);
    ctx.setTicket(issue?.key);
    if (issue) ctx.setDraft({ id: issue.key, branch: branchFor(issue.key, issue.summary) });
  };

  return <IssueTable workspace={ctx.workspace} selectedKey={selectedKey} onSelect={select} />;
};
