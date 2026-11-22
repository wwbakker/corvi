/** One Markdown-backed file being edited, in the frame the plan's editor takes: the source fills
 * it (the shared `MarkdownEditor`, every character visible) and the field documentation docks to
 * its right. The page owns the save; this is the editing experience. The documentation panel's
 * open/closed state is furniture and lives in a cookie pref (`prefs.ts`). */
import { type ComponentType, type JSX, useState } from "react";

import { MarkdownEditor } from "../editor/client/MarkdownEditor.tsx";
import { getPref, setPref } from "./prefs.ts";
import { fieldAtLine } from "./caretField.ts";
import { documentKey } from "./remember.ts";

export type EditorFile = {
  readonly id: string;
  readonly path: string;
  readonly problems?: readonly string[];
  /** Where the file came from; a harness editor uses it to find the matching resolved view. */
  readonly scope?: "builtin" | "global" | "workspace" | "repository";
  readonly workspace?: string;
  readonly repository?: string;
};

export function FileEditor({
  file,
  draft,
  notice,
  onDraft,
  onSave,
  onCancel,
  onDelete,
  documentName,
  placeholder,
  docsKey,
  Docs,
}: {
  file: EditorFile;
  /** The text as written so far. */
  draft: string;
  /** What the last save or delete said, while it lasts. */
  notice: string | null;
  onDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  /** The remembered-document name, so two kinds of file keep separate scroll positions. */
  documentName: string;
  placeholder: string;
  /** The cookie pref that remembers whether the panel is open. */
  docsKey: string;
  Docs: ComponentType<{ highlight?: string; file: EditorFile; draft: string }>;
}): JSX.Element {
  const [caret, setCaret] = useState(1);
  const [docs, setDocs] = useState<boolean>(() => getPref(docsKey) !== "closed");
  return (
    <>
      <header>
        <h2>{file.id}</h2>
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
        <button
          title={docs ? "close the field documentation" : "open the field documentation"}
          onClick={() => {
            setDocs(!docs);
            setPref(docsKey, docs ? "closed" : "open");
          }}
        >
          {docs ? "Hide docs" : "Show docs"}
        </button>
        <button onClick={onCancel}>Cancel</button>
        <button className="create" onClick={onSave}>
          Save
        </button>
        <button onClick={onDelete}>Delete</button>
      </header>
      <p className="hint">
        <code>{file.path}</code>
        {file.problems && file.problems.length > 0 && <> — {file.problems.join("; ")}</>}
      </p>
      <div className="action-editor">
        <MarkdownEditor
          fill
          value={draft}
          onChange={onDraft}
          onCaret={setCaret}
          remember={documentKey(documentName, file.path)}
          placeholder={placeholder}
        />
        {docs && <Docs highlight={fieldAtLine(draft, caret)} file={file} draft={draft} />}
      </div>
    </>
  );
}
