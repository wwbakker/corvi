import { type JSX, useEffect, useState } from "react";
import { api, post, type Change, type Created, type Selection } from "./api.ts";
import { RepoBrowser } from "../workspace/client/RepoBrowser.tsx";
import { StepHost, type StepContext, type StepInfo } from "./extensions.tsx";
import type { Workspace } from "../workspace/client/workspaces.ts";

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
  onCreated,
  onCancel,
}: {
  /** The contexts there are to choose from. */
  workspaces: Workspace[];
  /** The context the switcher is on. A specific one is prefilled and fixed — the switcher
   * decides, and changing it changes this wizard with it. Undefined, which is what "All work"
   * means, leaves the choice to the wizard. */
  workspace?: string;
  onCreated: (change: Change, provision: Created["provision"]) => void;
  onCancel: () => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const [id, setId] = useState("");
  const [branch, setBranch] = useState("");
  const [repos, setRepos] = useState<Selection[]>([]);
  const [ticket, setTicket] = useState<string>();
  const [payloads, setPayloads] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The change's context. The switcher's choice wins while it names one; "All work" hands the
  // decision to the wizard, which keeps its own — defaulting to the first context, which is
  // what the server would assume anyway.
  const [picked, setPicked] = useState<string>();
  const chosen = workspace ?? picked ?? workspaces[0]?.id;

  // Which steps this context has. Asked of the server, because that is where the extensions and
  // their enablement are known; asked again whenever the context changes, which is why a
  // context without Jira simply has no Jira step.
  const [steps, setSteps] = useState<StepInfo[]>();
  useEffect(() => {
    let alive = true;
    setSteps(undefined);
    api<{ steps: StepInfo[] }>(`/wizard${chosen ? `?workspace=${encodeURIComponent(chosen)}` : ""}`)
      .then((s) => alive && setSteps(s.steps))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [chosen]);

  const issueSteps = (steps ?? []).filter((s) => s.phase === "issue");
  const repoSteps = (steps ?? []).filter((s) => s.phase === "repos");
  const titles = [...issueSteps.map((s) => s.title), "Change", "Repositories", ...repoSteps.map((s) => s.title)];
  const changeStep = issueSteps.length;
  const reposStep = changeStep + 1;

  // Added as a worktree off the remote default; both are changed per repository afterwards.
  const addRepo = (path: string): void =>
    setRepos(repos.some((r) => r.path === path) ? repos : [...repos, { path, direct: false }]);
  const removeRepo = (path: string): void => setRepos(repos.filter((r) => r.path !== path));
  const changeRepo = (path: string, patch: Partial<Selection>): void =>
    setRepos(repos.map((r) => (r.path === path ? { ...r, ...patch } : r)));

  const create = (): void => {
    setBusy(true);
    setError(null);
    post<Created>("/changes", {
      id,
      branch,
      workspace: chosen,
      repos: repos.map((r) => r.path),
      direct: repos.filter((r) => r.direct).map((r) => r.path),
      base: Object.fromEntries(repos.filter((r) => r.base).map((r) => [r.path, r.base!])),
      // Each step's pick, under the extension's own name: the core stores it and never looks
      // inside.
      extensions: payloads,
    })
      .then((created) => onCreated(created.change, created.provision))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  /** What the steps share: the draft they prefill, the repositories picked so far, the ticket
   * the details step names, and their own slot of the change record. */
  const ctx: StepContext = {
    workspace: chosen,
    draft: { id, branch },
    setDraft: (patch) => {
      if (patch.id !== undefined) setId(patch.id);
      if (patch.branch !== undefined) setBranch(patch.branch);
    },
    repos,
    ticket,
    setTicket,
    setPayload: (extension, data) =>
      setPayloads((prev) => {
        const next = { ...prev };
        if (data === undefined) delete next[extension];
        else next[extension] = data;
        return next;
      }),
  };
  const panel = (info: StepInfo): JSX.Element => <StepHost key={info.id} info={info} ctx={ctx} />;

  return (
    <div className="wizard">
      <header>
        <h2>New change</h2>
      </header>

      <nav className="steps">
        {steps ? (
          titles.map((label, i) => (
            <button key={`${i}-${label}`} className={`step ${i === step ? "active" : ""}`} onClick={() => setStep(i)}>
              {i + 1}. {label}
            </button>
          ))
        ) : (
          <span className="hint">loading…</span>
        )}
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
                  onChange={(e) => setPicked(e.target.value)}
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
                Ticket
                <input value={ticket ?? "none"} readOnly />
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

          {repoSteps.map((info, i) => (changeStep + 2 + i === step ? panel(info) : null))}
        </>
      )}
    </div>
  );
}
