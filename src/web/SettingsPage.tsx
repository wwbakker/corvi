import { useEffect, useState } from "react";
import { api, put } from "./api.ts";
import { DEFAULT_WORKSPACE } from "./workspaces.ts";
// Types only: these are erased at build time, so the browser bundle gets none of the server's
// file handling with them.
import type { Settings, SettingsView } from "../settings.ts";
import type { Config, Workspace } from "../config.ts";

/**
 * Everything that lives in the config file, edited here rather than in an editor.
 *
 * The file stays the source of truth and stays hand-editable — this writes it, and the server
 * puts it into effect at once. Which is why the page is a thin thing: it knows the shape of the
 * settings and nothing about what they mean.
 *
 * Two conventions run through it. An empty field is "not set", and shows the value that applies
 * anyway as its placeholder, so the difference between a default and a decision stays visible.
 * And a setting an environment variable is overriding is locked, with the variable named: the
 * variable wins, so an editable box would be a lie.
 */

/** The draft as the page holds it: the file's contents, edited. */
type Draft = Settings;

function Field({
  label,
  hint,
  value,
  placeholder,
  locked,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  placeholder?: string;
  /** The environment variable overriding this, when there is one. */
  locked?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>
        {label}
        {locked && <span className="locked"> — set by {locked}</span>}
      </span>
      <input
        value={value ?? ""}
        placeholder={locked ? "" : placeholder}
        disabled={Boolean(locked)}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * A heading over several controls.
 *
 * Not a `<label>`: a label names exactly one control, and a `<button>` inside one is named by it
 * rather than by its own text — which makes "+ add" unclickable by name and, more to the point,
 * unannounceable to anything that reads the page aloud.
 */
function Group({
  label,
  hint,
  locked,
  children,
}: {
  label: string;
  hint?: string;
  locked?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span className="label">
        {label}
        {locked && <span className="locked"> — set by {locked}</span>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** A list of short strings — directories to copy, environments in deployment order. Rows rather
 * than a comma-separated box: the order matters for one of them, and a typo in a comma list is
 * hard to see. */
function ListEditor({
  label,
  hint,
  values,
  placeholder,
  locked,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  placeholder?: string;
  locked?: string;
  onChange: (values: string[]) => void;
}) {
  const set = (index: number, value: string): void =>
    onChange(values.map((v, i) => (i === index ? value : v)));

  return (
    <Group label={label} hint={hint} locked={locked}>
      {values.map((value, index) => (
        <div className="row" key={index}>
          <input
            value={value}
            placeholder={placeholder}
            disabled={Boolean(locked)}
            onChange={(e) => set(index, e.target.value)}
          />
          <button
            className="remove"
            title="remove"
            disabled={Boolean(locked)}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      {!locked && (
        <button className="add" onClick={() => onChange([...values, ""])}>
          + add
        </button>
      )}
    </Group>
  );
}

/** The environment a workspace adds to every CLI it runs: how two clients stop fighting over one
 * login. Names and values, because that is what it is. */
function EnvEditor({
  env,
  onChange,
}: {
  env: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}) {
  const entries = Object.entries(env);
  const write = (pairs: [string, string][]): void => onChange(Object.fromEntries(pairs));

  return (
    <Group
      label="Environment for this context"
      hint="Added to every gh, az and Jira call made in this context: GH_CONFIG_DIR for another GitHub account, AZURE_CONFIG_DIR for another tenant, JIRA_API_TOKEN for another site."
    >
      {entries.map(([key, value], index) => (
        <div className="row" key={index}>
          <input
            value={key}
            placeholder="GH_CONFIG_DIR"
            onChange={(e) => write(entries.map((p, i) => (i === index ? [e.target.value, p[1]] : p)))}
          />
          <input
            value={value}
            placeholder="~/.config/gh-client"
            onChange={(e) => write(entries.map((p, i) => (i === index ? [p[0], e.target.value] : p)))}
          />
          <button
            className="remove"
            title="remove"
            onClick={() => write(entries.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button className="add" onClick={() => write([...entries, ["", ""]])}>
        + add
      </button>
    </Group>
  );
}

/** The extensions a workspace runs, one switch each. Unlisted means all of them, which is what
 * IWE was before this existed — so the switches describe the truth, and a workspace that names
 * none has them all. */
function ExtensionToggles({
  known,
  selected,
  onChange,
}: {
  known: { name: string; title: string }[];
  selected: string[] | undefined;
  onChange: (extensions: string[] | undefined) => void;
}) {
  const enabled = (name: string): boolean => (selected ? selected.includes(name) : true);
  const toggle = (name: string, on: boolean): void => {
    const next = known
      .map((e) => e.name)
      .filter((n) => (n === name ? on : enabled(n)));
    // Back to everything: the key goes away, so the file stays a page of decisions.
    onChange(next.length === known.length ? undefined : next);
  };

  return (
    <Group
      label="Extensions"
      hint="What this context has at all: cards, wizard steps, hooks. Unchecked is absent here, not empty — and a workspace that names none has them all."
    >
      {known.map(({ name, title }) => (
        <label className="switch" key={name}>
          <input
            type="checkbox"
            checked={enabled(name)}
            onChange={(e) => toggle(name, e.target.checked)}
          />
          <span>{title}</span>
        </label>
      ))}
    </Group>
  );
}

/** One context: which repositories it starts from, and which integrations it has at all. There
 * is always at least one workspace: removing the last configured one leaves the draft empty,
 * and the Default workspace card takes its place. That default is not in the file, so it has
 * no Remove — `onRemove` is absent exactly then. */
function WorkspaceCard({
  workspace,
  extensions,
  onChange,
  onRemove,
}: {
  workspace: Workspace;
  /** The extensions there are to enable, in the order they were loaded. */
  extensions: { name: string; title: string }[];
  onChange: (next: Workspace) => void;
  onRemove?: () => void;
}) {
  const set = (patch: Partial<Workspace>): void => onChange({ ...workspace, ...patch });
  const jira = workspace.jira === false ? undefined : (workspace.jira ?? {});
  const azure = workspace.azure === false ? undefined : (workspace.azure ?? {});

  return (
    <div className="workspace-card">
      <div className="head">
        <input
          className="name"
          value={workspace.name}
          placeholder="Client"
          onChange={(e) => set({ name: e.target.value })}
        />
        <span className="spacer" />
        {onRemove && (
          <button className="remove" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>

      <Field
        label="Id"
        hint="Recorded in every change made here, and never changed afterwards: renaming it orphans them."
        value={workspace.id}
        onChange={(id) => set({ id })}
      />
      <Field
        label="Repositories start at"
        placeholder="the global setting"
        value={workspace.reposStart}
        onChange={(reposStart) => set({ reposStart })}
      />

      {/* Not a filter but a fact: a personal project has no ticket, and being asked for one is
          noise and a CLI call. */}
      <label className="switch">
        <input
          type="checkbox"
          checked={Boolean(jira)}
          onChange={(e) => set({ jira: e.target.checked ? {} : false })}
        />
        <span>This context has Jira</span>
      </label>
      {jira && (
        <div className="nested">
          <Field
            label="Project"
            placeholder="from the Jira config file"
            value={jira.project}
            onChange={(project) => set({ jira: { ...jira, project } })}
          />
          <Field
            label="Board"
            placeholder="from the Jira config file"
            value={jira.board}
            onChange={(board) => set({ jira: { ...jira, board } })}
          />
          <Field
            label="Jira config file"
            hint="A second client is a second site and a second account: jira init into another file."
            placeholder="~/.config/.jira/.config.yml"
            value={jira.configFile}
            onChange={(configFile) => set({ jira: { ...jira, configFile } })}
          />
          <Field
            label="Token variable"
            placeholder="JIRA_API_TOKEN"
            value={jira.tokenEnv}
            onChange={(tokenEnv) => set({ jira: { ...jira, tokenEnv } })}
          />
        </div>
      )}

      <label className="switch">
        <input
          type="checkbox"
          checked={Boolean(azure)}
          onChange={(e) => set({ azure: e.target.checked ? {} : false })}
        />
        <span>This context has Azure DevOps</span>
      </label>
      {azure && (
        <div className="nested">
          <Field
            label="Organisation"
            placeholder="the global setting"
            value={azure.organization}
            onChange={(organization) => set({ azure: { ...azure, organization } })}
          />
          <Field
            label="Project"
            placeholder="the global setting"
            value={azure.project}
            onChange={(project) => set({ azure: { ...azure, project } })}
          />
        </div>
      )}

      <EnvEditor env={workspace.env ?? {}} onChange={(env) => set({ env })} />
      <ExtensionToggles
        known={extensions}
        selected={workspace.extensions}
        onChange={(extensions) => set({ extensions })}
      />
    </div>
  );
}

export function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<SettingsView>("/settings")
      .then((v) => {
        setView(v);
        setDraft(v.file);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!view) {
    return (
      <div className="page">
        <header>
          <h2>Settings</h2>
        </header>
        {error ? <div className="error-banner">{error}</div> : <p className="hint">loading…</p>}
      </div>
    );
  }

  const effective: Config = view.effective;
  const lock = (field: string): string | undefined => view.overridden[field];
  const set = (patch: Draft): void => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };
  const deploy: Partial<Config["azureDeploy"]> = draft.azureDeploy ?? {};
  const setDeploy = (patch: Partial<Config["azureDeploy"]>): void =>
    set({ azureDeploy: { ...effective.azureDeploy, ...deploy, ...patch } });
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.file);

  const save = (): void => {
    setSaving(true);
    setError(undefined);
    put<SettingsView>("/settings", draft)
      .then((v) => {
        setView(v);
        setDraft(v.file);
        setSaved(true);
        // The sidebar's contexts come from the same file: it should not still be showing a
        // workspace that has just been renamed away.
        onSaved();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="page settings">
      <header>
        <h2>Settings</h2>
        <span className="spacer" />
        {saved && !dirty && <span className="hint saved">saved</span>}
        <button className="create" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <p className="hint">
        Written to <code>{view.path}</code>, which stays hand-editable. Saving takes effect at
        once — no restart.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <h2 className="section">Where things live</h2>
      <div className="form">
        <Field
          label="Changes root"
          hint="One directory per change: its worktrees and its change.json."
          value={draft.changesRoot}
          placeholder={effective.changesRoot}
          locked={lock("changesRoot")}
          onChange={(changesRoot) => set({ changesRoot })}
        />
        <Field
          label="Repositories root"
          hint="The repository browser cannot walk above this."
          value={draft.reposRoot}
          placeholder={effective.reposRoot}
          locked={lock("reposRoot")}
          onChange={(reposRoot) => set({ reposRoot })}
        />
        <Field
          label="Browser starts at"
          hint="Where it opens; ↑ Up still walks back to the root."
          value={draft.reposStart}
          placeholder={effective.reposStart}
          locked={lock("reposStart")}
          onChange={(reposStart) => set({ reposStart })}
        />
      </div>

      <h2 className="section">What a new worktree inherits</h2>
      <div className="form">
        <ListEditor
          label="Copied from the repository"
          hint="IDE and build-tool state, with the paths inside it rewritten to the worktree. Not build output: recreating that is a build, and a stale copy is worse than none."
          values={draft.worktreeCopy ?? effective.worktreeCopy}
          placeholder=".idea"
          locked={lock("worktreeCopy")}
          onChange={(worktreeCopy) => set({ worktreeCopy })}
        />
        {!lock("worktreeCopy") && (
          <button className="link" onClick={() => set({ worktreeCopy: view.toolingDefault })}>
            restore the defaults ({view.toolingDefault.join(" ")})
          </button>
        )}
      </div>

      <h2 className="section">Jira</h2>
      <div className="form">
        <Field
          label="Assign new issues to"
          placeholder="whoever the token belongs to"
          value={draft.jiraAssignee}
          locked={lock("jiraAssignee")}
          onChange={(jiraAssignee) => set({ jiraAssignee })}
        />
        <Field
          label="Transition on starting a change"
          value={draft.jiraStartTransition}
          placeholder={effective.jiraStartTransition}
          locked={lock("jiraStartTransition")}
          onChange={(jiraStartTransition) => set({ jiraStartTransition })}
        />
        <Field
          label="Transition on completing one"
          value={draft.jiraDoneTransition}
          placeholder={effective.jiraDoneTransition}
          locked={lock("jiraDoneTransition")}
          onChange={(jiraDoneTransition) => set({ jiraDoneTransition })}
        />
      </div>

      <h2 className="section">Azure DevOps</h2>
      <div className="form">
        <Field
          label="Organisation"
          placeholder="whatever az devops configure holds"
          value={draft.azureOrganization}
          locked={lock("azureOrganization")}
          onChange={(azureOrganization) => set({ azureOrganization })}
        />
        <Field
          label="Project"
          placeholder="whatever az devops configure holds"
          value={draft.azureProject}
          locked={lock("azureProject")}
          onChange={(azureProject) => set({ azureProject })}
        />
      </div>

      <h2 className="section">Deployments</h2>
      <div className="form">
        <Group
          label="How a build pipeline is named, and its deploy twin"
          hint="build-example-api deploys through deploy-example-api."
        >
          <div className="row">
            <input
              value={(deploy.pipeline ?? effective.azureDeploy.pipeline)[0]}
              onChange={(e) =>
                setDeploy({
                  pipeline: [e.target.value, (deploy.pipeline ?? effective.azureDeploy.pipeline)[1]],
                })
              }
            />
            <input
              value={(deploy.pipeline ?? effective.azureDeploy.pipeline)[1]}
              onChange={(e) =>
                setDeploy({
                  pipeline: [(deploy.pipeline ?? effective.azureDeploy.pipeline)[0], e.target.value],
                })
              }
            />
          </div>
        </Group>
        <Field
          label="Version parameter"
          hint="Learnt per pipeline when this name does not fit: a pipeline with one other parameter is telling you which it is."
          value={deploy.versionParameter}
          placeholder={effective.azureDeploy.versionParameter}
          onChange={(versionParameter) => setDeploy({ versionParameter })}
        />
        <Field
          label="Environment parameter"
          value={deploy.environmentParameter}
          placeholder={effective.azureDeploy.environmentParameter}
          onChange={(environmentParameter) => setDeploy({ environmentParameter })}
        />
        <ListEditor
          label="Environments"
          hint="In the order they are deployed to, which is the order the page shows them and the order promotion follows."
          values={deploy.environments ?? effective.azureDeploy.environments}
          placeholder="accept"
          locked={lock("azureDeploy.environments")}
          onChange={(environments) => setDeploy({ environments })}
        />
      </div>

      <h2 className="section">Workspaces</h2>
      <p className="hint">
        A context you work in: a client, or your own projects. Not only a filter — a context
        without Jira has no ticket to ask about, and one without Azure DevOps has no deployments
        page and no pipelines to look for.
      </p>
      <div className="form">
        {(draft.workspaces ?? []).map((workspace, index) => (
          <WorkspaceCard
            key={index}
            workspace={workspace}
            extensions={view.extensions}
            onChange={(next) =>
              set({ workspaces: (draft.workspaces ?? []).map((w, i) => (i === index ? next : w)) })
            }
            onRemove={() =>
              set({ workspaces: (draft.workspaces ?? []).filter((_, i) => i !== index) })
            }
          />
        ))}
        {!(draft.workspaces ?? []).length && (
          <WorkspaceCard
            workspace={DEFAULT_WORKSPACE}
            extensions={view.extensions}
            onChange={(next) => set({ workspaces: [next] })}
          />
        )}
        <button
          className="add"
          onClick={() =>
            set({ workspaces: [...(draft.workspaces ?? []), { id: "", name: "" }] })
          }
        >
          + add a workspace
        </button>
      </div>
    </div>
  );
}
