/** The change's harness-profile choices, in one dialog opened from the Actions menu. The title row holds
 * the change's identity and its menus; harness selection is a setting, not a title. */
import { type JSX, useEffect, useRef } from "react";
import type { CorviClient } from "@corvi/client";
import { ChangeId } from "@corvi/contracts/changes";
import type { Change } from "../app-root/api.ts";

import { SubagentHarnessProfileSelect } from "./SubagentHarnessProfileSelect.tsx";
import { UserHarnessProfileSelect } from "./UserHarnessProfileSelect.tsx";

export function ChangeHarnessProfilesDialog({
  open,
  change,
  client,
  blocked,
  onClose,
  onChanged,
}: {
  open: boolean;
  change: Change;
  client: CorviClient;
  blocked?: boolean;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="harness-choice-dialog"
      aria-label="change harness profiles"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // The dialog owns its keys: they must not reach the terminal or the page's chords.
      onKeyDownCapture={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <h2>Harness profiles</h2>
        <span className="spacer" />
        <button type="button" className="close" aria-label="close harnesses" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="hint">
        Every new pane starts in a harness profile. <strong>Default</strong> follows Settings → Harness
        profile defaults for this workspace; a choice here overrides it for this change only. Changes apply to
        new panes, never to a shell that is already running.
      </p>
      <div className="harness-choice-form">
        <UserHarnessProfileSelect
          changeId={change.id}
          client={client}
          stored={change.userHarnessProfile}
          disabled={blocked}
          label="Shell panes"
          onChanged={onChanged}
        />
        <SubagentHarnessProfileSelect
          changeId={ChangeId.make(change.id)}
          client={client}
          value={change.subagentHarnessProfile}
          disabled={blocked}
          label="New subagents"
          onChange={(key) => {
            void client.changes
              .rename(ChangeId.make(change.id), { subagentHarnessProfile: key })
              .then(onChanged);
          }}
        />
      </div>
      <footer>
        <span className="hint">The harness profile is also shown in each tab&apos;s tooltip.</span>
        <span className="spacer" />
        <button type="button" className="create" onClick={onClose}>
          Done
        </button>
      </footer>
    </dialog>
  );
}
