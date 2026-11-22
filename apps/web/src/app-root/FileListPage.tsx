/** A page of Markdown files by scope: the list, the editor's frame, the create flow, and one
 * change's checkout files. The action and subagent pages share it; what differs is the API, the
 * editor, the template a new file starts from and the words. */
import { type ComponentType, type JSX, type ReactNode, useCallback, useEffect, useState } from "react";

import { ChangeId } from "@corvi/contracts/changes";
import { apiClient, type Change } from "./api.ts";
import { isFinished } from "../domain/change.ts";
import type { LeaveGuard } from "./navigation.ts";
import { TemplatePicker } from "../actions/TemplatePicker.tsx";

/** The fields a row reads; both file DTOs have them. */
type FileShape = {
  readonly id: string;
  readonly path: string;
  readonly label?: string;
  readonly text: string;
  readonly problems?: readonly string[];
  readonly scope: "builtin" | "global" | "workspace" | "repository";
  readonly workspace?: string;
};

type ListingShape<F extends FileShape> = {
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly files: readonly F[];
};

type RepositoriesShape<F extends FileShape> = {
  readonly repositories: readonly { readonly repository: string; readonly files: readonly F[] }[];
};

/** Where a page write lands. A repository file belongs to one change's checkout: the change
 * names the checkout, the repository name its block in the Repositories view. */
type WriteTarget =
  | { scope: "global" | "workspace"; workspace?: string }
  | { scope: "repository"; changeId: string; repository: string };

type Editing<F> = { file: F; target: WriteTarget };

type WriteBody = { scope: "global" | "workspace"; workspace?: string; id: string; text: string };

type RepositoryWriteBody = { repository: string; id: string; text: string };

type FilesApi<F extends FileShape, L extends ListingShape<F>, R extends RepositoriesShape<F>> = {
  readonly files: () => Promise<L>;
  readonly repositoryFiles: (changeId: ChangeId) => Promise<R>;
  readonly writeFile: (body: WriteBody) => Promise<L>;
  readonly deleteFile: (ref: WriteBody | Omit<WriteBody, "text">) => Promise<L>;
  readonly writeRepositoryFile: (changeId: ChangeId, body: RepositoryWriteBody) => Promise<R>;
  readonly deleteRepositoryFile: (changeId: ChangeId, ref: Omit<RepositoryWriteBody, "text">) => Promise<R>;
};

type FileEditorProps<F extends FileShape> = {
  file: F;
  draft: string;
  notice: string | null;
  onDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
};

export function FileListPage<F extends FileShape, L extends ListingShape<F>, R extends RepositoriesShape<F>>({
  onGuard,
  api,
  view,
  pageClass,
  title,
  hint,
  empty,
  repositoryHint,
  subjectNoun,
  what,
  templateFor,
  Editor,
}: {
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
  api: FilesApi<F, L, R>;
  view: "actions" | "subagents" | "harnesses";
  pageClass: string;
  title: string;
  hint: ReactNode;
  empty: string;
  repositoryHint: ReactNode;
  subjectNoun: string;
  what: string;
  templateFor: (id: string) => string;
  Editor: ComponentType<FileEditorProps<F>>;
}): JSX.Element {
  const [listing, setListing] = useState<L | null>(null);
  const [editing, setEditing] = useState<Editing<F> | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // The Repositories block: the active changes to choose from, the chosen one, and what its
  // checkouts carry. Files are read per request, so a change is read when it is picked.
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<R | null>(null);
  // The create flow's open picker and the scope it will write to.
  const [picking, setPicking] = useState<WriteTarget | null>(null);

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
    api
      .files()
      .then(setListing)
      .catch((e: Error) => complain(e.message));
    apiClient.changes
      .list()
      .then((all) => setChanges(all.filter((change) => !isFinished(change))))
      .catch((e: Error) => complain(e.message));
  }, []);

  const pick = (id: string): void => {
    setSelected(id);
    setRepositories(null);
    api
      .repositoryFiles(ChangeId.make(id))
      .then(setRepositories)
      .catch((e: Error) => complain(e.message));
  };

  /** Write the file and say what happened; resolves to whether it was written. A failure keeps
   * the draft and lands in the notice — whichever button started the save. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!editing) return false;
    const { file, target } = editing;
    setNotice(null);
    try {
      if (target.scope === "repository") {
        const fresh = await api.writeRepositoryFile(ChangeId.make(target.changeId), {
          repository: target.repository,
          id: file.id,
          text: draft,
        });
        setRepositories(fresh);
      } else {
        const write: WriteBody = { ...target, id: file.id, text: draft };
        const fresh = await api.writeFile(write);
        setListing(fresh);
      }
      setEditing(null);
      say(`Saved ${file.id}.md`);
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
      view: { name: view },
      dirty: editing !== null && draft !== editing.file.text,
      subject: editing === null ? `Unsaved ${subjectNoun}` : `Unsaved changes to ${editing.file.id}.md`,
      save,
    });
    return () => onGuard(null);
  }, [editing, draft, save, onGuard]);

  const remove = (file: F, target: WriteTarget): void => {
    if (!window.confirm(`Delete ${file.id}.md? This cannot be undone.`)) return;
    const gone = (): void => {
      setEditing(null);
      say(`Deleted ${file.id}.md`);
    };
    if (target.scope === "repository") {
      api
        .deleteRepositoryFile(ChangeId.make(target.changeId), {
          repository: target.repository,
          id: file.id,
        })
        .then((fresh) => {
          setRepositories(fresh);
          gone();
        })
        .catch((e: Error) => complain(e.message));
      return;
    }
    api
      .deleteFile({ ...target, id: file.id })
      .then((fresh) => {
        setListing(fresh);
        gone();
      })
      .catch((e: Error) => complain(e.message));
  };

  /** Create is one write of the chosen text — a blank file or a template's copy — followed by
   * the editor's frame on it. Not a blind upsert: an id that already exists in the scope would
   * overwrite that file's content. */
  const create = (target: WriteTarget, id: string, text: string): void => {
    const listed =
      target.scope === "repository"
        ? ((repositories?.repositories ?? []).find((block) => block.repository === target.repository)
            ?.files ?? [])
        : (listing?.files ?? []).filter((f) => f.scope === target.scope && f.workspace === target.workspace);
    if (listed.some((f) => f.id === id)) {
      complain(`${id}.md already exists — edit it instead`);
      return;
    }
    setPicking(null);
    const made = (file: F | undefined): void => {
      if (file) {
        setEditing({ file, target });
        setDraft(file.text);
      }
      say(`Created ${id}.md`);
    };
    if (target.scope === "repository") {
      api
        .writeRepositoryFile(ChangeId.make(target.changeId), {
          repository: target.repository,
          id,
          text,
        })
        .then((fresh) => {
          setRepositories(fresh);
          made(
            fresh.repositories
              .find((block) => block.repository === target.repository)
              ?.files.find((f) => f.id === id),
          );
        })
        .catch((e: Error) => complain(e.message));
      return;
    }
    api
      .writeFile({ ...target, id, text })
      .then((fresh) => {
        setListing(fresh);
        made(
          fresh.files.find(
            (f) =>
              f.id === id &&
              (target.scope === "workspace"
                ? f.scope === "workspace" && f.workspace === target.workspace
                : f.scope === "global"),
          ),
        );
      })
      .catch((e: Error) => complain(e.message));
  };

  const filesOf = (scope: F["scope"], workspace?: string): F[] =>
    (listing?.files ?? []).filter((f) => f.scope === scope && f.workspace === workspace);

  const row = (file: F, target: WriteTarget): JSX.Element => (
    <p key={file.path} className="file-row">
      <strong>{file.label ?? file.id}</strong> <code>{file.id}.md</code>
      {file.problems && <span className="summary">{file.problems.join("; ")}</span>}
      <span className="spacer" />
      <button
        onClick={() => {
          setEditing({ file, target });
          setDraft(file.text);
        }}
      >
        Edit
      </button>
      <button onClick={() => remove(file, target)}>Delete</button>
    </p>
  );

  const section = (
    title: string,
    files: F[],
    target: Extract<WriteTarget, { scope: "global" | "workspace" }>,
  ): JSX.Element => (
    <section className="widget" key={title}>
      <h3>
        {title}
        <span className="spacer" />
        <button className="create" onClick={() => setPicking(target)}>
          New
        </button>
      </h3>
      {files.length === 0 && <p className="hint">{empty}</p>}
      {files.map((file) => row(file, target))}
    </section>
  );

  // Editing is the editor's frame, not a card on the list: the same page, one view at a time.
  if (editing) {
    return (
      <div className={`page ${pageClass} editing`}>
        <Editor
          file={editing.file}
          draft={draft}
          notice={notice}
          onDraft={setDraft}
          onSave={save}
          onCancel={() => setEditing(null)}
          onDelete={() => remove(editing.file, editing.target)}
        />
      </div>
    );
  }

  return (
    <div className={`page ${pageClass}`}>
      <header>
        <h2>{title}</h2>
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
      </header>
      <p className="hint">{hint}</p>
      {section("Global", filesOf("global"), { scope: "global" })}
      {(listing?.workspaces ?? []).map((workspace) =>
        section(workspace.name, filesOf("workspace", workspace.id), {
          scope: "workspace",
          workspace: workspace.id,
        }),
      )}
      <section className="widget">
        <h3>
          Repositories
          <span className="spacer" />
          <select aria-label="change" value={selected ?? ""} onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>
              select a change
            </option>
            {changes.map((change) => (
              <option key={change.id} value={change.id}>
                {change.title || change.id}
              </option>
            ))}
          </select>
        </h3>
        <p className="hint">{repositoryHint}</p>
        {selected !== null &&
          (repositories?.repositories ?? []).map((block) => (
            <div key={block.repository}>
              <h4>
                {block.repository}
                <span className="spacer" />
                <button
                  className="create"
                  onClick={() =>
                    setPicking({ scope: "repository", changeId: selected, repository: block.repository })
                  }
                >
                  New
                </button>
              </h4>
              {block.files.length === 0 && <p className="hint">{empty}</p>}
              {block.files.map((file) =>
                row(file, { scope: "repository", changeId: selected, repository: block.repository }),
              )}
            </div>
          ))}
      </section>
      {picking !== null && (
        <TemplatePicker
          what={what}
          templates={filesOf("builtin")}
          blank={templateFor}
          onCreate={(id, text) => create(picking, id, text)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
