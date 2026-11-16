/** One action file being edited, in the shared file editor: the Markdown source, the action field
 * documentation beside it, and the page's save. */
import { type JSX } from "react";
import type { ActionFileDto } from "@corvi/contracts/actions";

import { FileEditor } from "../app-root/FileEditor.tsx";
import { ActionDocs } from "./ActionDocs.tsx";

export function ActionEditor({
  file,
  draft,
  notice,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  file: ActionFileDto;
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
      documentName="action"
      placeholder="YAML frontmatter for the delivery (label, kind, target, …), the body for what it says or runs."
      docsKey="corvi:actions-docs"
      Docs={ActionDocs}
    />
  );
}
