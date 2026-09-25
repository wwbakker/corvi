/** One action file being edited, in the frame the plan's editor takes: the Markdown source
 * fills it — the shared `MarkdownEditor`, every character of the markup visible — and the field
 * documentation docks to its right. It replaces the Actions page's list while it is open;
 * Cancel goes back to the list.
 *
 * The save is the page's: one write on Save, at once (a built-in file's save copies it to
 * Global). This is the editing experience, not the save contract — the stale-file banner the
 * plan editor carries is deliberately not here yet. The documentation panel's open/closed state
 * is furniture and lives in a cookie pref (app-root/prefs.ts), like the sidebar's width. */
import { type JSX, useState } from "react";
import type { ActionFileDto } from "@corvi/contracts/actions";
import { MarkdownEditor } from "../editor/client/MarkdownEditor.tsx";
import { documentKey } from "../app-root/remember.ts";
import { getPref, setPref } from "../app-root/prefs.ts";
import { ActionDocs } from "./ActionDocs.tsx";
import { fieldAtLine } from "./caretField.ts";

/** Whether the documentation panel is showing, kept between visits. */
const DOCS_KEY = "corvi:actions-docs";

export function ActionEditor({
  file,
  draft,
  notice,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  /** The file being edited: its id, its path, and what the listing last found wrong with it. */
  file: ActionFileDto;
  /** The text as written so far. */
  draft: string;
  /** What the last save or delete said, while it lasts. */
  notice: string | null;
  /** Every edit, as the whole file. */
  onDraft: (text: string) => void;
  /** Write the file at once. */
  onSave: () => void;
  /** Back to the list, dropping the draft. */
  onCancel: () => void;
  /** Delete the file (none for a built-in: it is not ours to remove). */
  onDelete?: () => void;
}): JSX.Element {
  const [caret, setCaret] = useState(1);
  const [docs, setDocs] = useState<boolean>(() => getPref(DOCS_KEY) !== "closed");
  return (
    <>
      <header>
        <h2>{file.scope === "builtin" ? `${file.id} — saving copies it to Global` : file.id}</h2>
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
        <button
          title={docs ? "close the field documentation" : "open the field documentation"}
          onClick={() => {
            setDocs(!docs);
            setPref(DOCS_KEY, docs ? "closed" : "open");
          }}
        >
          {docs ? "Hide docs" : "Show docs"}
        </button>
        <button onClick={onCancel}>Cancel</button>
        <button className="create" onClick={onSave}>
          Save
        </button>
        {onDelete && <button onClick={onDelete}>Delete</button>}
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
          remember={documentKey("action", file.path)}
          placeholder={
            "YAML frontmatter for the delivery (label, kind, target, …), the body for what it says or runs."
          }
        />
        {docs && <ActionDocs highlight={fieldAtLine(draft, caret)} />}
      </div>
    </>
  );
}
