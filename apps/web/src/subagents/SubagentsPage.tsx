/** The Subagents page: the profile files behind a change's subagent menu, one row per file, by
 * scope.
 *
 * Files are the source of truth and each saves its own — there is no page-wide draft to keep or
 * lose. Built-ins are read-only: saving one copies it to Global, where the copy shadows the
 * shipped file and deleting it brings the default back. Repository profiles are not managed here
 * at all — the note at the bottom says where they live instead.
 *
 * Editing one file leaves the list for the editor's frame (`ProfileEditor`): the Markdown source
 * in the shared editor, the fields' documentation beside it. What is typed there is a draft
 * until Save — so leaving it behind with unsaved edits is the shell's question to ask
 * (docs/decisions/unsaved-changes.md). */
import { type JSX, useCallback, useEffect, useState } from "react";

import type {
  SubagentFileWriteDto,
  SubagentFilesResponseDto,
  SubagentProfileFileDto,
} from "@corvi/contracts/subagents";
import { apiClient } from "../app-root/api.ts";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { ProfileEditor } from "./ProfileEditor.tsx";

/** Where a page-editable file lives. Built-ins save to Global (copy-on-edit); a repository file
 * is never listed here, so Global is the rest. */
type WriteTarget = { scope: "global" | "workspace"; workspace?: string };

const targetOf = (file: SubagentProfileFileDto): WriteTarget =>
  file.scope === "workspace" ? { scope: "workspace", workspace: file.workspace } : { scope: "global" };

/** A new profile starts as the smallest file that parses: a label and a harness. */
const templateFor = (id: string): string => `---\nlabel: ${id}\nharness: pi\n---\n`;

/** The id input beside a scope's heading: creating is writing the first version of the file. */
function NewProfile({ onCreate }: { onCreate: (id: string) => void }): JSX.Element {
  const [id, setId] = useState("");
  return (
    <>
      <input
        value={id}
        placeholder="new-profile"
        aria-label="new profile id"
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

export function SubagentsPage({
  onGuard,
}: {
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  const [listing, setListing] = useState<SubagentFilesResponseDto | null>(null);
  const [editing, setEditing] = useState<SubagentProfileFileDto | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const say = (message: string): void => {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  };

  const complain = (message: string): void => {
    setNotice(message);
  };

  useEffect(() => {
    apiClient.subagents.files().then(setListing).catch((e: Error) => complain(e.message));
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!editing) return false;
    const write: SubagentFileWriteDto = { ...targetOf(editing), id: editing.id, text: draft };
    setNotice(null);
    try {
      const fresh = await apiClient.subagents.writeFile(write);
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
      view: { name: "subagents" },
      dirty: editing !== null && draft !== editing.text,
      subject: editing === null ? "Unsaved profile" : `Unsaved changes to ${editing.id}.md`,
      save,
    });
    return () => onGuard(null);
  }, [editing, draft, save, onGuard]);

  const remove = (file: SubagentProfileFileDto): void => {
    if (!window.confirm(`Delete ${file.id}.md? This cannot be undone.`)) return;
    apiClient
      .subagents.deleteFile({ ...targetOf(file), id: file.id })
      .then((fresh) => {
        setListing(fresh);
        setEditing(null);
        say(`Deleted ${file.id}.md`);
      })
      .catch((e: Error) => complain(e.message));
  };

  const create = (target: WriteTarget, id: string): void => {
    // New is not a blind upsert: an id that already exists in this scope would overwrite that
    // file's content with the blank template.
    const exists = (listing?.files ?? []).some(
      (f) => f.id === id && f.scope === target.scope && f.workspace === target.workspace,
    );
    if (exists) {
      complain(`${id}.md already exists — edit it instead`);
      return;
    }
    apiClient
      .subagents.writeFile({ ...target, id, text: templateFor(id) })
      .then((fresh) => {
        setListing(fresh);
        const made = fresh.files.find(
          (f) =>
            f.id === id &&
            (target.scope === "workspace"
              ? f.scope === "workspace" && f.workspace === target.workspace
              : f.scope === "global"),
        );
        if (made) {
          setEditing(made);
          setDraft(made.text);
        }
        say(`Created ${id}.md`);
      })
      .catch((e: Error) => complain(e.message));
  };

  const filesOf = (scope: SubagentProfileFileDto["scope"], workspace?: string): SubagentProfileFileDto[] =>
    (listing?.files ?? []).filter((f) => f.scope === scope && f.workspace === workspace);

  const section = (
    title: string,
    files: SubagentProfileFileDto[],
    target: WriteTarget | undefined,
  ): JSX.Element => (
    <section className="widget" key={title}>
      <h3>
        {title}
        <span className="spacer" />
        {target && <NewProfile onCreate={(id) => create(target, id)} />}
      </h3>
      {files.length === 0 && <p className="hint">no profiles yet</p>}
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
          {target && file.scope !== "builtin" && <button onClick={() => remove(file)}>Delete</button>}
        </p>
      ))}
    </section>
  );

  if (editing) {
    return (
      <div className="page subagents-page editing">
        <ProfileEditor
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
    <div className="page subagents-page">
      <header>
        <h2>Subagents</h2>
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
      </header>
      <p className="hint">
        A profile is a template for a subagent: which harness to start, the model and effort, and
        the initial prompt. Each profile is one file — YAML frontmatter for the settings, the body
        for the prompt — and saving writes that file at once.
      </p>
      {section("Built-in", filesOf("builtin"), undefined)}
      {section("Global", filesOf("global"), { scope: "global" })}
      {(listing?.workspaces ?? []).map((workspace) =>
        section(workspace.name, filesOf("workspace", workspace.id), {
          scope: "workspace",
          workspace: workspace.id,
        }),
      )}
      <p className="hint">
        Profiles can also live in a checkout (<code>&lt;checkout&gt;/.corvi/subagents/&lt;id&gt;.md</code>
        ), show up in that change's menu and run like any other profile, and are created with your
        IDE or by the agent — this page does not manage them.
      </p>
    </div>
  );
}
