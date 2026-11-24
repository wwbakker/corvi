/** One harness profile file being edited: the Markdown source, its field documentation, and the resolved
 * environment for a change beside it. */
import { type JSX } from "react";
import type { HarnessProfileFileDto } from "@corvi/contracts/harness-profiles";

import { FileEditor } from "../app-root/FileEditor.tsx";
import { HarnessProfileDocs } from "./HarnessProfileDocs.tsx";

export function HarnessProfileEditor({
  file,
  draft,
  notice,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  file: HarnessProfileFileDto;
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
      documentName="harness"
      placeholder="YAML frontmatter for the environment (label, harness, basedOnHarnessProfile, model, effort, instructions, sections), the body for notes."
      docsKey="corvi:harnesses-docs"
      Docs={HarnessProfileDocs}
    />
  );
}
