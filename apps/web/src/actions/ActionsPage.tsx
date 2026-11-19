/** The Actions page: the files behind the change's Actions menu, one row per file, by scope. The
 * shared `FileListPage` holds the list/editor/create frame; this supplies the actions API, editor
 * and words. */
import { type JSX } from "react";

import { apiClient } from "../app-root/api.ts";
import { FileListPage } from "../app-root/FileListPage.tsx";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { ActionEditor } from "./ActionEditor.tsx";

/** A new action starts as the smallest file that parses: a label and what it delivers. */
const templateFor = (id: string): string => `---\nlabel: ${id}\nkind: prompt\ntarget: active\n---\n`;

export function ActionsPage({
  onGuard,
}: {
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  return (
    <FileListPage
      onGuard={onGuard}
      api={apiClient.actions}
      view="actions"
      pageClass="actions-page"
      title="Actions"
      hint="The change's Actions menu runs these. Each action is one file — YAML frontmatter for where it goes, the body for what it says — and saving writes that file at once."
      empty="no actions yet"
      repositoryHint={
        <>
          The actions a change's checkouts carry (<code>&lt;checkout&gt;/.corvi/actions/&lt;id&gt;.md</code>)
          — they show up in that change's menu and run like any other action.
        </>
      }
      subjectNoun="action"
      what="action"
      templateFor={templateFor}
      Editor={ActionEditor}
    />
  );
}
