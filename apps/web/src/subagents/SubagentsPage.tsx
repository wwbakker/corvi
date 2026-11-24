/** The Subagents page: the profile files behind a change's subagent menu, one row per file, by
 * scope. The shared `FileListPage` holds the list/editor/create frame; this supplies the profile
 * API, editor and words. */
import { type JSX } from "react";

import { apiClient } from "../app-root/api.ts";
import { FileListPage } from "../app-root/FileListPage.tsx";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { ProfileEditor } from "./ProfileEditor.tsx";

/** A new profile starts as the smallest file that parses: a label and a harness. */
const templateFor = (id: string): string => `---\nlabel: ${id}\nharness: pi\n---\n`;

export function SubagentsPage({
  onGuard,
}: {
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  return (
    <FileListPage
      onGuard={onGuard}
      api={apiClient.subagents}
      view="subagents"
      pageClass="subagents-page"
      title="Subagents"
      hint="A profile is a template for a subagent: the harness profile it is based on, the model and effort, and the initial prompt. Each profile is one file — YAML frontmatter for the settings, the body for the prompt — and saving writes that file at once."
      empty="no profiles yet"
      repositoryHint={
        <>
          The profiles a change's checkouts carry (
          <code>&lt;checkout&gt;/.corvi/subagents/&lt;id&gt;.md</code>) — they show up in that change's menu
          and run like any other profile.
        </>
      }
      subjectNoun="profile"
      what="profile"
      templateFor={templateFor}
      Editor={ProfileEditor}
    />
  );
}
