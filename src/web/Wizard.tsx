import { useState } from "react";
import { branchFor } from "../branch.ts";
import { post, type Change, type Created, type Issue, type Selection } from "./api.ts";
import { IssueTable } from "./IssueTable.tsx";
import { RepoBrowser } from "./RepoBrowser.tsx";

/** One step per component: the change is configured component by component, then created. */
export function Wizard({
  workspace,
  hasJira = true,
  onCreated,
  onCancel,
}: {
  /** The context it is made in, recorded on the change. */
  workspace?: string;
  /** Whether this context has a Jira at all: a personal project has no ticket to pick, and a
   * step that can only say so is a step in the way. */
  hasJira?: boolean;
  onCreated: (change: Change, provision: Created["provision"]) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [id, setId] = useState("");
  const [branch, setBranch] = useState("");
  const [repos, setRepos] = useState<Selection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Picking an issue only prefills; the fields on the next step stay editable.
  const select = (picked: Issue | null) => {
    setIssue(picked);
    if (!picked) return;
    setId(picked.key);
    setBranch(branchFor(picked.key, picked.summary));
  };

  // Added as a worktree off the remote default; both are changed per repository afterwards.
  const addRepo = (path: string) =>
    setRepos(repos.some((r) => r.path === path) ? repos : [...repos, { path, direct: false }]);
  const removeRepo = (path: string) => setRepos(repos.filter((r) => r.path !== path));
  const changeRepo = (path: string, patch: Partial<Selection>) =>
    setRepos(repos.map((r) => (r.path === path ? { ...r, ...patch } : r)));

  // The steps this context has. Without Jira the first one is not empty, it is absent.
  const steps = hasJira ? (["Jira", "Change", "Repositories"] as const) : (["Change", "Repositories"] as const);
  const jiraStep = hasJira ? 0 : -1;
  const changeStep = hasJira ? 1 : 0;
  const reposStep = hasJira ? 2 : 1;

  const create = () => {
    setBusy(true);
    setError(null);
    post<Created>("/changes", {
      id,
      branch,
      workspace,
      jira: issue?.key,
      repos: repos.map((r) => r.path),
      direct: repos.filter((r) => r.direct).map((r) => r.path),
      base: Object.fromEntries(repos.filter((r) => r.base).map((r) => [r.path, r.base!])),
    })
      .then((created) => onCreated(created.change, created.provision))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="wizard">
      <header>
        <h2>New change</h2>
      </header>

      <nav className="steps">
        {steps.map((label, i) => (
          <button
            key={label}
            className={`step ${i === step ? "active" : ""}`}
            onClick={() => setStep(i)}
          >
            {i + 1}. {label}
          </button>
        ))}
        <span className="spacer" />
        {/* Creating is possible from any step once the required fields are set: only the change
            id is required, the branch defaults to it and repositories can be added later. */}
        <button
          className="primary"
          disabled={!id.trim() || repos.length === 0 || busy}
          title={repos.length === 0 ? "select at least one repository" : undefined}
          onClick={create}
        >
          {busy ? "Creating…" : "Create change"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </nav>

      {error && <div className="error-banner">{error}</div>}

      {step === jiraStep && <IssueTable workspace={workspace} selected={issue} onSelect={select} />}

      {step === changeStep && (
        <div className="form">
          <label>
            Change id
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. PROJ-123" />
            <small>Used as the directory name under the changes root.</small>
          </label>
          <label>
            Branch
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={id || "defaults to the change id"}
            />
          </label>
          <label>
            Jira issue
            <input value={issue?.key ?? "none"} readOnly />
          </label>
        </div>
      )}

      {step === reposStep && (
        <div className="form wide">
          <p className="hint">
            Select the repositories this change touches. Each one is set up on{" "}
            <code>{branch || id || "the branch"}</code>: as a <b>worktree</b>, a separate checkout
            in the change directory, or <b>in place</b>, which puts the repository's own checkout
            on that branch and links it here. The second box is the branch the work starts from —
            the remote default, unless this change builds on another one.
          </p>
          <RepoBrowser
            selected={repos}
            onAdd={addRepo}
            onRemove={removeRepo}
            onChange={changeRepo}
          />
        </div>
      )}

    </div>
  );
}
