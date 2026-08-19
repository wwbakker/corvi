import { useState } from "react";
import { branchFor } from "../branch.ts";
import { post, type Change, type Created, type Issue } from "./api.ts";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { IssueTable } from "./IssueTable.tsx";
import { RepoBrowser } from "./RepoBrowser.tsx";

/** One step per component: the change is configured component by component, then created. */
const steps = ["Jira", "Change", "Repositories"] as const;

export function Wizard({
  onCreated,
  onCancel,
  onHome,
}: {
  onCreated: (change: Change, provision: Created["provision"]) => void;
  onCancel: () => void;
  onHome: () => void;
}) {
  const [step, setStep] = useState(0);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [id, setId] = useState("");
  const [branch, setBranch] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Picking an issue only prefills; the fields on the next step stay editable.
  const select = (picked: Issue | null) => {
    setIssue(picked);
    if (!picked) return;
    setId(picked.key);
    setBranch(branchFor(picked.key, picked.summary));
  };

  const addRepo = (path: string) => setRepos(repos.includes(path) ? repos : [...repos, path]);
  const removeRepo = (path: string) => setRepos(repos.filter((r) => r !== path));

  const create = () => {
    setBusy(true);
    setError(null);
    post<Created>("/changes", { id, branch, jira: issue?.key, repos })
      .then((created) => onCreated(created.change, created.provision))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="wizard">
      <header>
        <Breadcrumb trail={["New change"]} onHome={onHome} />
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

      {step === 0 && (
        <IssueTable selected={issue} onSelect={select} />
      )}

      {step === 1 && (
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

      {step === 2 && (
        <div className="form wide">
          <p className="hint">
            Select the repositories this change touches. A git worktree on{" "}
            <code>{branch || id || "the branch"}</code> is created in each.
          </p>
          <RepoBrowser selected={repos} onAdd={addRepo} onRemove={removeRepo} />
        </div>
      )}

    </div>
  );
}
