/** The Subagents page: the profile files behind a change's subagent menu, one row per file, by
 * scope.
 *
 * Files are the source of truth and each saves its own — there is no page-wide draft to keep or
 * lose. Creating starts from a template — Blank, or a copy of a built-in (`TemplatePicker`) —
 * and the copy shadows the shipped file while it exists. The Repositories block lists one
 * change's checkout files — pick an active change, see what its checkouts carry — and creates,
 * edits and deletes them like any other file.
 *
 * Editing one file leaves the list for the editor's frame (`ProfileEditor`): the Markdown source
 * in the shared editor, the fields' documentation beside it. What is typed there is a draft
 * until Save — so leaving it behind with unsaved edits is the shell's question to ask
 * (docs/decisions/unsaved-changes.md). */
import { type JSX, useCallback, useEffect, useState } from "react";

import { ChangeId } from "@corvi/contracts/changes";
import type {
  SubagentFileWriteDto,
  SubagentFilesResponseDto,
  SubagentProfileFileDto,
  SubagentRepositoryFilesResponseDto,
} from "@corvi/contracts/subagents";
import { apiClient, type Change } from "../app-root/api.ts";
import { isFinished } from "../domain/change.ts";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { TemplatePicker } from "../actions/TemplatePicker.tsx";
import { ProfileEditor } from "./ProfileEditor.tsx";

/** Where a page write lands. A repository file belongs to one change's checkout: the change
 * names the checkout, the repository name its block in the Repositories view. */
type WriteTarget =
  | { scope: "global" | "workspace"; workspace?: string }
  | { scope: "repository"; changeId: string; repository: string };

/** A listed file and where a write for it lands — a repository file carries the block it was
 * listed in. */
type Editing = { file: SubagentProfileFileDto; target: WriteTarget };

/** A new profile starts as the smallest file that parses: a label and a harness. */
const templateFor = (id: string): string => `---\nlabel: ${id}\nharness: pi\n---\n`;

export function SubagentsPage({
  onGuard,
}: {
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  const [listing, setListing] = useState<SubagentFilesResponseDto | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // The Repositories block: the active changes to choose from, the chosen one, and what its
  // checkouts carry. Files are read per request, so a change is read when it is picked.
  const [changes, setChanges] = useState<Change[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<SubagentRepositoryFilesResponseDto | null>(null);
  // The create flow's open picker and the scope it will write to.
  const [picking, setPicking] = useState<WriteTarget | null>(null);

  const say = (message: string): void => {
    setNotice(message);
    setTimeout(() => setNotice(null), 2500);
  };

  const complain = (message: string): void => {
    setNotice(message);
  };

  useEffect(() => {
    apiClient.subagents.files().then(setListing).catch((e: Error) => complain(e.message));
    apiClient.changes
      .list()
      .then((all) => setChanges(all.filter((change) => !isFinished(change))))
      .catch((e: Error) => complain(e.message));
  }, []);

  const pick = (id: string): void => {
    setSelected(id);
    setRepositories(null);
    apiClient.subagents
      .repositoryFiles(ChangeId.make(id))
      .then(setRepositories)
      .catch((e: Error) => complain(e.message));
  };

  const save = useCallback(async (): Promise<boolean> => {
    if (!editing) return false;
    const { file, target } = editing;
    setNotice(null);
    try {
      if (target.scope === "repository") {
        const fresh = await apiClient.subagents.writeRepositoryFile(ChangeId.make(target.changeId), {
          repository: target.repository,
          id: file.id,
          text: draft,
        });
        setRepositories(fresh);
      } else {
        const write: SubagentFileWriteDto = { ...target, id: file.id, text: draft };
        const fresh = await apiClient.subagents.writeFile(write);
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
      view: { name: "subagents" },
      dirty: editing !== null && draft !== editing.file.text,
      subject: editing === null ? "Unsaved profile" : `Unsaved changes to ${editing.file.id}.md`,
      save,
    });
    return () => onGuard(null);
  }, [editing, draft, save, onGuard]);

  const remove = (file: SubagentProfileFileDto, target: WriteTarget): void => {
    if (!window.confirm(`Delete ${file.id}.md? This cannot be undone.`)) return;
    const gone = (): void => {
      setEditing(null);
      say(`Deleted ${file.id}.md`);
    };
    if (target.scope === "repository") {
      apiClient.subagents
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
    apiClient.subagents
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
        ? (repositories?.repositories ?? []).find((block) => block.repository === target.repository)
            ?.files ?? []
        : (listing?.files ?? []).filter(
            (f) => f.scope === target.scope && f.workspace === target.workspace,
          );
    if (listed.some((f) => f.id === id)) {
      complain(`${id}.md already exists — edit it instead`);
      return;
    }
    setPicking(null);
    const made = (file: SubagentProfileFileDto | undefined): void => {
      if (file) {
        setEditing({ file, target });
        setDraft(file.text);
      }
      say(`Created ${id}.md`);
    };
    if (target.scope === "repository") {
      apiClient.subagents
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
    apiClient.subagents
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

  const filesOf = (scope: SubagentProfileFileDto["scope"], workspace?: string): SubagentProfileFileDto[] =>
    (listing?.files ?? []).filter((f) => f.scope === scope && f.workspace === workspace);

  const row = (file: SubagentProfileFileDto, target: WriteTarget): JSX.Element => (
    <p key={file.path}>
      <strong>{file.label ?? file.id}</strong> <code>{file.id}.md</code>
      {file.problems && <span className="summary"> — {file.problems.join("; ")}</span>}
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
    files: SubagentProfileFileDto[],
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
      {files.length === 0 && <p className="hint">no profiles yet</p>}
      {files.map((file) => row(file, target))}
    </section>
  );

  // Editing is the editor's frame, not a card on the list: the same page, one view at a time.
  if (editing) {
    return (
      <div className="page subagents-page editing">
        <ProfileEditor
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
          <select
            aria-label="change"
            value={selected ?? ""}
            onChange={(e) => pick(e.target.value)}
          >
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
        <p className="hint">
          The profiles a change's checkouts carry (<code>&lt;checkout&gt;/.corvi/subagents/&lt;id&gt;.md</code>
          ) — they show up in that change's menu and run like any other profile.
        </p>
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
              {block.files.length === 0 && <p className="hint">no profiles yet</p>}
              {block.files.map((file) =>
                row(file, { scope: "repository", changeId: selected, repository: block.repository }),
              )}
            </div>
          ))}
      </section>
      {picking !== null && (
        <TemplatePicker
          what="profile"
          templates={filesOf("builtin")}
          blank={templateFor}
          onCreate={(id, text) => create(picking, id, text)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
