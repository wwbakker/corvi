/** One profile file being edited, in the shared file editor: the Markdown source, the profile
 * field documentation beside it, and the page's save. */
import { type JSX } from "react";
import type { SubagentProfileFileDto } from "@corvi/contracts/subagents";

import { FileEditor } from "../app-root/FileEditor.tsx";
import { ProfileDocs } from "./ProfileDocs.tsx";

export function ProfileEditor({
  file,
  draft,
  notice,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  file: SubagentProfileFileDto;
  draft: string;
  notice: string | null;
  onDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <FileEditor
      file={file}
      draft={draft}
      notice={notice}
      onDraft={onDraft}
      onSave={onSave}
      onCancel={onCancel}
      onDelete={onDelete}
      documentName="profile"
      placeholder="YAML frontmatter for the settings (label, harness, model, …), the body for the initial prompt."
      docsKey="corvi:subagents-docs"
      Docs={ProfileDocs}
    />
  );
}
