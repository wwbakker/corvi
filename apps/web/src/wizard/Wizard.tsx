import { type JSX, useEffect, useState } from "react";
import { apiClient, type Change, type Created, type Selection } from "../app-root/api.ts";
import { slugFor } from "../domain/change.ts";
import { RepoBrowser } from "../workspace/client/RepoBrowser.tsx";
import { StepHost, type StepInfo } from "../integrations/client.tsx";
import type { Workspace } from "../workspace/client/workspaces.ts";
import { stepContext, toChangeDraft, type Draft, type DraftPatch } from "./draft.ts";
import { MarkdownEditor } from "../editor/client/MarkdownEditor.tsx";

/**
 * The "Create change" wizard.
 *
 * The steps are the extensions': asked of the server for the context in hand (`/api/wizard`),
 * rendered through StepHost, and laid out in phases — issue steps first (they prefill the id
 * and branch), then the change details, then the repositories, then steps that want the
 * repositories. The core owns exactly two panels and none of the opinions.
 */
export function Wizard({
  workspaces,
  workspace,
  draft,
  onChange,
  onCreated,
  onDiscard,
}: {
  /** The contexts there are to choose from. */
  workspaces: Workspace[];
  /** The context the switcher is on. A specific one is prefilled and fixed — the switcher
   * decides, and changing it changes this wizard with it. Undefined, which is what "All work"
   * means, leaves the choice to the wizard. */
  workspace?: string;
  /** The form so far, owned by the App so that leaving this page does not lose it. Every field
   * the wizard would otherwise keep in `useState` is in here. */
  draft: Draft;
  /** One patch to the draft; the App applies it to what it holds. */
  onChange: (patch: DraftPatch) => void;
  onCreated: (change: Change, provision: Created["provision"]) => void;
  /** Throw the draft away: nothing is written until "Create idea". */
  onDiscard: () => void;
}): JSX.Element {
  const { step, id, branch, title, description, repos, ticket, idTouched, branchTouched } = draft;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The change's context. The switcher's choice wins while it names one; "All work" hands the
  // decision to the wizard, which keeps its own — defaulting to the first context, which is
  // what the server would assume anyway.
  const chosen = workspace ?? draft.picked ?? workspaces[0]?.id;

  // Which steps this context has. Asked of the server, because that is where the extensions and
  // their enablement are known; asked again whenever the context changes, which is why a
  // context without Jira simply has no Jira step.
  const [steps, setSteps] = useState<StepInfo[]>();
  useEffect(() => {
    let alive = true;
    setSteps(undefined);
    apiClient
      .wizardSteps(chosen)
      .then((steps) => alive && setSteps(steps))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [chosen]);

  const issueSteps = (steps ?? []).filter((s) => s.phase === "issue");
  const repoSteps = (steps ?? []).filter((s) => s.phase === "repos");
  const titles = [...issueSteps.map((s) => s.title), "Idea", "Repositories", ...repoSteps.map((s) => s.title)];
  const changeStep = issueSteps.length;
  const reposStep = changeStep + 1;

  // Added as a worktree off the remote default with the change's branch; both are changed per
  // repository afterwards.
  const addRepo = (path: string): void =>
    onChange({
      repos: repos.some((r) => r.path === path)
        ? repos
        : [...repos, { path, location: "new", branch: { kind: "change" } }],
    });
  const removeRepo = (path: string): void => onChange({ repos: repos.filter((r) => r.path !== path) });
  const changeRepo = (path: string, patch: Partial<Selection>): void =>
    onChange({ repos: repos.map((r) => (r.path === path ? { ...r, ...patch } : r)) });

  // The title is the source: the id and the branch follow it, until you edit either by hand —
  // after which they are yours. A picked issue claims both (setDraft below).
  const editTitle = (value: string): void =>
    onChange({
      title: value,
      ...(idTouched ? {} : { id: slugFor(value) }),
      ...(branchTouched ? {} : { branch: slugFor(value) }),
    });
  const editId = (value: string): void =>
    onChange({ id: value, idTouched: true, ...(branchTouched ? {} : { branch: value }) });
  const editBranch = (value: string): void => onChange({ branch: value, branchTouched: true });

  const create = (): void => {
    setBusy(true);
    setError(null);
    apiClient
      .create(toChangeDraft(draft, chosen))
      .then((created) => onCreated(created.change, created.provision))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  /** What the steps share, built from the draft: their prefill, the repositories picked so far,
   * the ticket this page names, and their own slot of the creation record. */
  const ctx = stepContext(draft, chosen, onChange);
  const panel = (info: StepInfo): JSX.Element => <StepHost key={info.id} info={info} ctx={ctx} />;

  return (
    <div className="wizard">
      <header>
        <h2>New idea</h2>
      </header>

      <nav className="steps">
        {steps ? (
          titles.map((label, i) => (
            <button key={`${i}-${label}`} className={`step ${i === step ? "active" : ""}`} onClick={() => onChange({ step: i })}>
              {i + 1}. {label}
            </button>
          ))
        ) : (
          <span className="hint">loading…</span>
        )}
        <span className="spacer" />
        {/* Creating is possible from any step once the required fields are set: only the change
            id is required — repositories can be added now or after the work starts, and the plan
            can be empty. */}
        <button
          className="primary"
          disabled={!id.trim() || busy}
          onClick={create}
        >
          {busy ? "Creating…" : "Create idea"}
        </button>
        <button onClick={onDiscard}>Discard</button>
      </nav>

      {error && <div className="error-banner">{error}</div>}

      {steps && (
        <>
          {issueSteps.map((info, i) => (i === step ? panel(info) : null))}

          {step === changeStep && (
            <div className="form">
              <label>
                Workspace
                <select
                  value={chosen ?? ""}
                  disabled={Boolean(workspace)}
                  onChange={(e) => onChange({ picked: e.target.value })}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <small>
                  {workspace
                    ? "the context the switcher is on — change it there"
                    : "which context this change belongs to"}
                </small>
              </label>
              <label>
                Title
                <input
                  value={title}
                  onChange={(e) => editTitle(e.target.value)}
                  placeholder="What this idea is about"
                />
                <small>The id and branch below follow it until you edit them.</small>
              </label>
              <label>
                Description
                <MarkdownEditor
                  rows={6}
                  value={description}
                  onChange={(text) => onChange({ description: text })}
                  placeholder="The starting plan. Stored as PLAN.md, for you and the agent to shape."
                />
              </label>
              <label>
                Change id
                <input
                  value={id}
                  onChange={(e) => editId(e.target.value)}
                  placeholder="e.g. PROJ-123"
                />
                <small>Used as the directory name under the changes root.</small>
              </label>
              <label>
                Branch name
                <input
                  value={branch}
                  onChange={(e) => editBranch(e.target.value)}
                  placeholder={id || "defaults to the change id"}
                />
              </label>
              <label>
                Ticket
                <input value={ticket ?? "none"} readOnly />
              </label>
            </div>
          )}

          {step === reposStep && (
            <div className="form wide">
              <p className="hint">
                Select the repositories this change touches. Each one answers two questions: where
                its checkout lives — a <b>new worktree</b> in the change directory, or the
                repository's own checkout <b>in place</b> — and which branch it uses: the change's
                own (<code>{branch || id || "the branch"}</code>), an <b>existing branch</b>, or the
                checkout's <b>current branch</b>. A new branch starts where <i>starts from</i> says,
                and a pull request merges into <i>merges into</i>.
              </p>
              <RepoBrowser
                workspace={chosen}
                selected={repos}
                onAdd={addRepo}
                onRemove={removeRepo}
                onChange={changeRepo}
              />
            </div>
          )}

          {repoSteps.map((info, i) => (changeStep + 2 + i === step ? panel(info) : null))}
        </>
      )}
    </div>
  );
}
