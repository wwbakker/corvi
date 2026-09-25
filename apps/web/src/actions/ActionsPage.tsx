/** The Actions page: the files behind the terminal page's menu, one row per file, by scope.
 *
 * Files are the source of truth and each saves its own — there is no page-wide draft to keep or
 * lose. Built-ins are read-only: saving one copies it to Global, where the copy shadows the
 * shipped file and deleting it brings the default back. Repository actions are not managed here
 * at all — the note at the bottom says where they live instead.
 *
 * Editing one file leaves the list for the editor's frame (`ActionEditor`): the Markdown source
 * in the shared editor, the fields' documentation beside it. What is typed there is a draft
 * until Save — so leaving it behind with unsaved edits is the shell's question to ask
 * (docs/decisions/unsaved-changes.md). */
import { type JSX, useCallback, useEffect, useState } from "react";

import type {
  ActionFileDto,
  ActionFileWriteDto,
  ActionFilesResponseDto,
} from "@corvi/contracts/actions";
import { apiClient } from "../app-root/api.ts";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { ActionEditor } from "./ActionEditor.tsx";

/** Where a page-editable file lives. Built-ins save to Global (copy-on-edit); a repository file
 * is never listed here, so Global is the rest. */
type WriteTarget = { scope: "global" | "workspace"; workspace?: string };

const targetOf = (file: ActionFileDto): WriteTarget =>
  file.scope === "workspace" ? { scope: "workspace", workspace: file.workspace } : { scope: "global" };

/** A new action starts as the smallest file that parses: a label and what it delivers. */
const templateFor = (id: string): string => `---\nlabel: ${id}\nkind: prompt\ntarget: active\n---\n`;

/** The id input beside a scope's heading: creating is writing the first version of the file. */
function NewAction({ onCreate }: { onCreate: (id: string) => void }): JSX.Element {
  const [id, setId] = useState("");
  return (
    <>
      <input
        value={id}
        placeholder="new-action"
        aria-label="new action id"
        onChange={(e) => setId(e.target.value.trim())}
      />
      <button
        className="create"
        disabled={!id}
        onClick={() => {
          onCreate(id);
          setId("");
        }}
      >
        New
      </button>
    </>
  );
}

export function ActionsPage({
  onGuard,
}: {
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  const [listing, setListing] = useState<ActionFilesResponseDto | null>(null);
  const [editing, setEditing] = useState<ActionFileDto | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  /** A confirmation, while it lasts. */
  const say = (message: string): void => {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  };

  /** What went wrong, for as long as it takes to see it: a refused save lands back on this
   * page, and a note that has already faded explains nothing. The next attempt replaces it. */
  const complain = (message: string): void => {
    setNotice(message);
  };

  useEffect(() => {
    apiClient.actionFiles().then(setListing).catch((e: Error) => complain(e.message));
  }, []);

  /** Write the file and say what happened; resolves to whether it was written. A failure keeps
   * the draft and lands in the notice — whichever button started the save. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!editing) return false;
    const write: ActionFileWriteDto = { ...targetOf(editing), id: editing.id, text: draft };
    setNotice(null);
    try {
      const fresh = await apiClient.writeActionFile(write);
      setListing(fresh);
      setEditing(null);
      say(`Saved ${write.id}.md`);
      return true;
    } catch (e) {
      complain(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [editing, draft]);

  // The leave guard: unsaved edits are the draft that differs from the file, and the one save
  // that ends it is this page's own — the same write its Save button makes.
  useEffect(() => {
    onGuard({
      view: { name: "actions" },
      dirty: editing !== null && draft !== editing.text,
      subject: editing === null ? "Unsaved action" : `Unsaved changes to ${editing.id}.md`,
      save,
    });
    return () => onGuard(null);
  }, [editing, draft, save, onGuard]);

  const remove = (file: ActionFileDto): void => {
    if (!window.confirm(`Delete ${file.id}.md? This cannot be undone.`)) return;
    apiClient
      .deleteActionFile({ ...targetOf(file), id: file.id })
      .then((fresh) => {
        setListing(fresh);
        setEditing(null);
        say(`Deleted ${file.id}.md`);
      })
      .catch((e: Error) => complain(e.message));
  };

  const create = (target: WriteTarget, id: string): void => {
    apiClient
      .writeActionFile({ ...target, id, text: templateFor(id) })
      .then((fresh) => {
        setListing(fresh);
        const made = fresh.files.find(
          (f) =>
            f.id === id &&
            (target.scope === "workspace" ? f.scope === "workspace" && f.workspace === target.workspace : f.scope === "global"),
        );
        if (made) {
          setEditing(made);
          setDraft(made.text);
        }
        say(`Created ${id}.md`);
      })
      .catch((e: Error) => complain(e.message));
  };

  const filesOf = (scope: ActionFileDto["scope"], workspace?: string): ActionFileDto[] =>
    (listing?.files ?? []).filter((f) => f.scope === scope && f.workspace === workspace);

  const section = (
    title: string,
    files: ActionFileDto[],
    target: WriteTarget | undefined,
  ): JSX.Element => (
    <section className="widget" key={title}>
      <h3>
        {title}
        <span className="spacer" />
        {target && <NewAction onCreate={(id) => create(target, id)} />}
      </h3>
      {files.length === 0 && <p className="hint">no actions yet</p>}
      {files.map((file) => (
        <p key={file.path}>
          <strong>{file.label ?? file.id}</strong> <code>{file.id}.md</code>
          {file.problems && <span className="summary"> — {file.problems.join("; ")}</span>}
          <span className="spacer" />
          <button
            onClick={() => {
              setEditing(file);
              setDraft(file.text);
            }}
          >
            Edit
          </button>
          {target && file.scope !== "builtin" && (
            <button onClick={() => remove(file)}>Delete</button>
          )}
        </p>
      ))}
    </section>
  );

  // Editing is the editor's frame, not a card on the list: the same page, one view at a time.
  if (editing) {
    return (
      <div className="page actions-page editing">
        <ActionEditor
          file={editing}
          draft={draft}
          notice={notice}
          onDraft={setDraft}
          onSave={save}
          onCancel={() => setEditing(null)}
          onDelete={editing.scope === "builtin" ? undefined : () => remove(editing)}
        />
      </div>
    );
  }

  return (
    <div className="page actions-page">
      <header>
        <h2>Actions</h2>
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
      </header>
      <p className="hint">
        The terminal page's menu runs these. Each action is one file — YAML frontmatter for where
        it goes, the body for what it says — and saving writes that file at once.
      </p>
      {section("Built-in", filesOf("builtin"), undefined)}
      {section("Global", filesOf("global"), { scope: "global" })}
      {(listing?.workspaces ?? []).map((workspace) =>
        section(
          workspace.name,
          filesOf("workspace", workspace.id),
          { scope: "workspace", workspace: workspace.id },
        ),
      )}
      <p className="hint">
        Actions can also live in a checkout (<code>&lt;checkout&gt;/.corvi/actions/&lt;id&gt;.md</code>
        ), show up in that change's menu and run like any other action, and are created with your
        IDE or by the agent — this page does not manage them.
      </p>
    </div>
  );
}
