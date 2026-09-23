import { type JSX, useState } from "react";
import type { CardInfo, Change } from "../../app-root/api.ts";
import { isFinished } from "../../domain/change.ts";
import { editorOf } from "../../integrations/client.tsx";

/**
 * A card's edit affordance and the dialog behind it: one hook, two slots, because the pencil
 * belongs in the card's header row while the dialog belongs outside it.
 *
 * A card gets a pencil when its declaration says it is editable, its integration ships an
 * editor, and the change is still open — a finished change's record is read-only, and the
 * editor's own route refuses the write too.
 */
export function useCardEditor({
  info,
  change,
  workspace,
  onSaved,
}: {
  info: CardInfo;
  change: Change | undefined;
  workspace?: string;
  onSaved: (change: Change) => void;
}): { button: JSX.Element | null; dialog: JSX.Element | null } {
  const [editing, setEditing] = useState(false);
  const Edit = editorOf(info.name);
  if (!info.editable || !Edit || !change || isFinished(change)) {
    return { button: null, dialog: null };
  }
  return {
    button: (
      <>
        <span className="spacer" />
        <button className="icon" title={`Edit ${info.title}`} onClick={() => setEditing(true)}>
          ✎
        </button>
      </>
    ),
    dialog: (
      <Edit
        change={change}
        workspace={workspace}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={onSaved}
      />
    ),
  };
}
