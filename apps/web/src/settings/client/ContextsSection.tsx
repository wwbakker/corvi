import { type JSX } from "react";
import { DEFAULT_WORKSPACE, type WorkspaceDto } from "@corvi/contracts/config";
import { CheckField, Field } from "./SettingsFields.tsx";
import { RemoteWorkspaceSection } from "./RemoteWorkspaceSection.tsx";

/**
 * The workspace-only Contexts form: what a context is called, the id its changes record, whether
 * another server hosts it, and the way to remove it.
 *
 * `onRemove` is absent for the synthetic Default workspace — the one that stands in when the file
 * names none — because it is not in the file to remove.
 */
export function ContextsSection({
  workspace,
  onChange,
  onRemove,
}: {
  workspace: WorkspaceDto;
  onChange: (next: WorkspaceDto) => void;
  onRemove?: () => void;
}): JSX.Element {
  const remote = workspace.remote;
  return (
    <div className="form">
      <Field
        label="Name"
        hint="What this context is called: a client, or your own projects."
        placeholder="Client"
        value={workspace.name}
        onChange={(name) => onChange({ ...workspace, name })}
      />
      <Field
        label="Id"
        hint="Recorded in every change made here, and never changed afterwards: renaming it orphans them."
        value={workspace.id}
        onChange={(id) => onChange({ ...workspace, id })}
      />
      <CheckField
        label="Hosted on another server"
        hint="A workspace another Corvi server hosts. Its settings live there; this machine is a client for it."
        checked={remote !== undefined}
        onChange={(on) => {
          if (on) {
            // Its settings live on the host, so the local ones go. The target starts on this
            // workspace's own id — the usual answer, and easy to change.
            const { settings: _settings, ...rest } = workspace;
            onChange({
              ...rest,
              remote: { url: "", workspace: workspace.id || DEFAULT_WORKSPACE.id },
            });
          } else {
            const { remote: _remote, ...rest } = workspace;
            onChange({ ...rest });
          }
        }}
      />
      {remote && (
        <RemoteWorkspaceSection
          remote={remote}
          onChange={(next) => onChange({ ...workspace, remote: next })}
        />
      )}
      {onRemove && (
        <button className="remove" onClick={onRemove}>
          Remove this context
        </button>
      )}
    </div>
  );
}
