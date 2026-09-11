import type { Workspace } from "../../core/domain/config.ts";
import { Field, Group, type KnownExtension } from "../../settings/client/SettingsFields.tsx";
import type { JSX } from "react";

/** The environment a workspace adds to every CLI it runs: how two clients stop fighting over one
 * login. Names and values, because that is what it is. */
function EnvEditor({
  env,
  onChange,
}: {
  env: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}): JSX.Element {
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

/** The extensions a workspace runs, one switch each. Unlisted means all of them: the switches
 * describe the truth, so a workspace that names none has every one of them. */
function ExtensionToggles({
  known,
  selected,
  onChange,
}: {
  known: KnownExtension[];
  selected: string[] | undefined;
  onChange: (extensions: string[] | undefined) => void;
}): JSX.Element {
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

/** One workspace: which repositories it starts from, and which integrations it has at all. There
 * is always at least one workspace: removing the last configured one leaves the draft empty,
 * and the Default workspace card takes its place. That default is not in the file, so it has
 * no Remove — `onRemove` is absent exactly then. */
export function WorkspaceCard({
  workspace,
  extensions,
  onChange,
  onRemove,
}: {
  workspace: Workspace;
  /** The extensions there are to enable, in the order they were loaded, each with the
   * per-workspace settings it declares. */
  extensions: KnownExtension[];
  onChange: (next: Workspace) => void;
  onRemove?: () => void;
}): JSX.Element {
  const set = (patch: Partial<Workspace>): void => onChange({ ...workspace, ...patch });
  const azure = workspace.azure === false ? undefined : (workspace.azure ?? {});
  // The same enablement the ExtensionToggles show: absent means all of them.
  const enabled = (name: string): boolean =>
    workspace.extensions ? workspace.extensions.includes(name) : true;
  const setExtensionField = (name: string, key: string, value: string): void => {
    const all = workspace.extensionSettings ?? {};
    set({ extensionSettings: { ...all, [name]: { ...(all[name] ?? {}), [key]: value } } });
  };

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

      {/* The per-workspace settings each enabled extension declares, bound to where the
          extension itself reads them back. Created on demand; the save prunes the empties. */}
      {extensions.map(({ name, workspaceSettings }) =>
        enabled(name) && workspaceSettings.length ? (
          <div className="nested" key={name}>
            {workspaceSettings.map((field) => (
              <Field
                key={field.key}
                label={field.label}
                hint={field.hint}
                placeholder={field.placeholder}
                value={workspace.extensionSettings?.[name]?.[field.key]}
                onChange={(value) => setExtensionField(name, field.key, value)}
              />
            ))}
          </div>
        ) : null,
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
