import { EditReposDialog } from "../../dashboard/client/EditReposDialog.tsx";
import type { EditComponent } from "../client.tsx";

/**
 * The git integration's client half: the Local changes card's repository editor, which predates
 * the card-edit mechanism and now hangs on its pencil like the ticket cards' link editors.
 */
export const edit: EditComponent = ({ change, workspace, open, onClose, onSaved }) => (
  <EditReposDialog
    changeId={change.id}
    workspace={workspace}
    open={open}
    onClose={onClose}
    onSaved={onSaved}
  />
);
