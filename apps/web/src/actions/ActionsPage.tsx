/** The Actions page: the files behind the terminal page's menu, one row per file, by scope.
 *
 * Files are the source of truth and each saves its own — there is no page-wide draft to keep or
 * lose. Built-ins are read-only: saving one copies it to Global, where the copy shadows the
 * shipped file and deleting it brings the default back. Repository actions are not managed here
 * at all — the note at the bottom says where they live instead. */
import { type JSX, useEffect, useState } from "react";

import type {
  ActionFileDto,
  ActionFileWriteDto,
  ActionFilesResponseDto,
} from "@corvi/contracts/actions";
import { apiClient } from "../app-root/api.ts";

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

export function ActionsPage(): JSX.Element {
  const [listing, setListing] = useState<ActionFilesResponseDto | null>(null);
  const [editing, setEditing] = useState<ActionFileDto | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const say = (message: string): void => {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  };

  useEffect(() => {
    apiClient.actionFiles().then(setListing).catch((e: Error) => say(e.message));
  }, []);

  const save = (): void => {
    if (!editing) return;
    const write: ActionFileWriteDto = { ...targetOf(editing), id: editing.id, text: draft };
    apiClient
      .writeActionFile(write)
      .then((fresh) => {
        setListing(fresh);
        setEditing(null);
        say(`Saved ${write.id}.md`);
      })
      .catch((e: Error) => say(e.message));
  };

  const remove = (file: ActionFileDto): void => {
    if (!window.confirm(`Delete ${file.id}.md? This cannot be undone.`)) return;
    apiClient
      .deleteActionFile({ ...targetOf(file), id: file.id })
      .then((fresh) => {
        setListing(fresh);
        setEditing(null);
        say(`Deleted ${file.id}.md`);
      })
      .catch((e: Error) => say(e.message));
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
      .catch((e: Error) => say(e.message));
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
      {editing && (
        <section className="widget">
          <h3>
            {editing.scope === "builtin" ? `${editing.id} — saving copies it to Global` : editing.id}
            <span className="spacer" />
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="create" onClick={save}>
              Save
            </button>
            {editing.scope !== "builtin" && <button onClick={() => remove(editing)}>Delete</button>}
          </h3>
          <p className="hint">
            <code>{editing.path}</code>
          </p>
          <textarea
            className="plan"
            rows={14}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </section>
      )}
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
