import { type JSX, type RefObject, useEffect, useRef, useState } from "react";
import { apiClient, type Change, type Created, type Selection } from "../app-root/api.ts";
import { RepoBrowser } from "../workspace/client/RepoBrowser.tsx";
import { StepHost, type StepContext, type StepInfo, type StepPick } from "../integrations/client.tsx";
import type { Workspace } from "../workspace/client/workspaces.ts";
import {
  planPatch,
  seedPatch,
  stepContext,
  toChangeDraft,
  type Draft,
  type DraftPatch,
} from "./draft.ts";
import { firstHeading } from "./plan.ts";
import { MarkdownEditor } from "../editor/client/MarkdownEditor.tsx";

/**
 * The "Create change" wizard: one screen, the plan on the left and everything else on the right.
 *
 * The left half is PLAN.md's starting text in the Markdown editor, seeded from the plan template
 * and named by its first heading. The right half is the sections the old step tabs held, one
 * after another: each extension step collapsed to its pick (a read-only field with an "Edit…"
 * that opens the step's own browser in a dialog), the change's details, the repositories as a
 * small list with the same kind of edit button, and then the steps that want the repositories.
 * The steps are the extensions': asked of the server for the context in hand (`/api/wizard`),
 * rendered through StepHost, and the core owns none of the opinions.
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
  const { id, branch, plan, repos, picks, idTouched, branchTouched } = draft;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The change's context. The switcher's choice wins while it names one; "All work" hands the
  // decision to the wizard, which keeps its own — defaulting to the first context, which is
  // what the server would assume anyway.
  const chosen = workspace ?? draft.picked ?? workspaces[0]?.id;

  // Which steps this context has, and the plan template in effect there. Asked of the server,
  // because that is where the extensions, their enablement and the settings are known; asked
  // again whenever the context changes, which is why a context without Jira simply has no Jira
  // section.
  const [steps, setSteps] = useState<StepInfo[]>();
  const [template, setTemplate] = useState<string>();
  useEffect(() => {
    let alive = true;
    setSteps(undefined);
    apiClient
      .wizard(chosen)
      .then((found) => {
        if (!alive) return;
        setSteps(found.steps);
        setTemplate(found.planTemplate);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [chosen]);

  // The template fills a fresh draft's plan once — while it is still empty — and never rewrites
  // the text you have. Its heading is the one a picked issue may replace (draft.ts).
  useEffect(() => {
    if (template === undefined || draft.planSeeded) return;
    onChange((d) => (d.planSeeded ? {} : seedPatch(d, template)));
  }, [template, draft.planSeeded, onChange]);

  const issueSteps = (steps ?? []).filter((s) => s.phase === "issue");
  const repoSteps = (steps ?? []).filter((s) => s.phase === "repos");

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

  // The plan's heading is the title's one-way source: typing it moves the title, and with it the
  // id and the branch — until you edit either by hand, after which they are yours. A picked
  // issue claims all three (draft.ts).
  const editPlan = (text: string): void => onChange((d) => planPatch(d, text));
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
   * their pick's place in the form, and their own slot of the creation record. */
  const ctx = stepContext(draft, chosen, onChange);
  const title = firstHeading(plan);

  return (
    <div className="wizard">
      <header>
        <h2>New idea</h2>
        <span className="spacer" />
        {/* Creating is possible once the required field is set — only the change id is
            required: repositories can be added now or after the work starts, and the plan can
            be empty. */}
        <button className="primary" disabled={!id.trim() || busy} onClick={create}>
          {busy ? "Creating…" : "Create idea"}
        </button>
        <button onClick={onDiscard}>Discard</button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="wizard-body">
        <div className="wizard-plan">
          <MarkdownEditor
            fill
            value={plan}
            onChange={editPlan}
            placeholder="What this change is, and how it might work. Stored as PLAN.md, for you and the agent to shape."
          />
        </div>

        <div className="wizard-sections">
          {!steps && <span className="hint">loading…</span>}
          {issueSteps.map((info) => (
            <StepField key={info.id} info={info} ctx={ctx} pick={picks[info.extension]} />
          ))}

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
              <input value={title} readOnly placeholder="named by the plan's first # heading" />
              <small>Named by the plan&apos;s first # heading.</small>
            </label>
            <label>
              Change id
              <input value={id} onChange={(e) => editId(e.target.value)} placeholder="e.g. PROJ-123" />
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
          </div>

          <ReposField
            workspace={chosen}
            branchLabel={branch || id || "the change's branch"}
            repos={repos}
            onAdd={addRepo}
            onRemove={removeRepo}
            onChange={changeRepo}
          />

          {repoSteps.map((info) => (
            <StepField key={info.id} info={info} ctx={ctx} pick={picks[info.extension]} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A modal dialog closed by its button, Escape or the × — the platform's own behavior. The
 * effect is what opens and closes it from this component's state. */
function useDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

/**
 * One step, collapsed to what its pick is: the field that shows it and the browser behind
 * "Edit…", which is the step's own component in a dialog. The core knows nothing about what is
 * picked — a step that has picked nothing shows "none" and its browser opens on the question.
 */
function StepField({
  info,
  ctx,
  pick,
}: {
  info: StepInfo;
  ctx: StepContext;
  pick: StepPick | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useDialog(open);

  return (
    <div className="field">
      <span className="label">{info.title}</span>
      <div className="row">
        <input
          aria-label={info.title}
          value={pick?.label ?? "none"}
          readOnly
          title={pick?.name}
          className={pick ? "" : "none"}
        />
        <button type="button" className="choose" onClick={() => setOpen(true)}>
          Edit…
        </button>
      </div>
      <dialog ref={ref} className="wide" onClose={() => setOpen(false)}>
        <h3>{info.title}</h3>
        <StepHost info={info} ctx={ctx} />
        <div className="dialog-actions">
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </dialog>
    </div>
  );
}

/** The repositories, as the small list of what is picked and the browser behind "Edit…". Each
 * one answers two questions: where its checkout lives — a new worktree in the change directory,
 * or the repository's own checkout in place — and which branch it uses. */
function ReposField({
  workspace,
  branchLabel,
  repos,
  onAdd,
  onRemove,
  onChange,
}: {
  workspace?: string;
  /** What a checkout on the change's own branch is called here: the branch the change named. */
  branchLabel: string;
  repos: Selection[];
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  onChange: (path: string, patch: Partial<Selection>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useDialog(open);

  return (
    <div className="field repos-field">
      <span className="label">Repositories</span>
      {repos.length === 0 ? (
        <div className="row">
          <input aria-label="Repositories" value="none" readOnly className="none" />
          <button type="button" className="choose" onClick={() => setOpen(true)}>
            Edit…
          </button>
        </div>
      ) : (
        <ul className="picked-repos">
          {repos.map((r) => (
            <li key={r.path}>
              <span className="name">{r.path.split("/").pop()}</span>
              <span className="what">
                {r.location === "new" ? "new worktree" : "in place"} ·{" "}
                {r.branch.kind === "change"
                  ? branchLabel
                  : r.branch.kind === "current"
                    ? "current branch"
                    : r.branch.name}
              </span>
            </li>
          ))}
        </ul>
      )}
      {repos.length > 0 && (
        <div className="row">
          <button type="button" className="choose" onClick={() => setOpen(true)}>
            Edit…
          </button>
        </div>
      )}
      <dialog ref={ref} className="wide" onClose={() => setOpen(false)}>
        <h3>Repositories</h3>
        <p className="hint">
          Select the repositories this change touches. Each one answers two questions: where its
          checkout lives — a <b>new worktree</b> in the change directory, or the repository's own
          checkout <b>in place</b> — and which branch it uses: the change&apos;s own (
          <code>{branchLabel}</code>), an <b>existing branch</b>, or the checkout&apos;s{" "}
          <b>current branch</b>. A new branch starts where <i>starts from</i> says, and a pull
          request merges into <i>merges into</i>.
        </p>
        <RepoBrowser
          workspace={workspace}
          selected={repos}
          onAdd={onAdd}
          onRemove={onRemove}
          onChange={onChange}
        />
        <div className="dialog-actions">
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </dialog>
    </div>
  );
}
