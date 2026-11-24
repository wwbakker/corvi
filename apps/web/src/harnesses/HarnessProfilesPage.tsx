/** The Harness profiles page: the named, file-defined Pi environments, one row per file by scope. The
 * shared FileListPage holds the list/editor/create frame; the editor carries the resolved view. */
import { type JSX } from "react";

import { apiClient } from "../app-root/api.ts";
import { FileListPage } from "../app-root/FileListPage.tsx";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { HarnessProfileEditor } from "./HarnessProfileEditor.tsx";

/** A new harness profile starts as the smallest file that parses: a label. Without a base it
 * inherits the built-in `pi`, so nothing else has to be said. */
const templateFor = (id: string): string => `---\nlabel: ${id}\n---\n`;

export function HarnessProfilesPage({
  onGuard,
}: {
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  return (
    <FileListPage
      onGuard={onGuard}
      api={apiClient.harnessProfiles}
      view="harnesses"
      pageClass="harnesses-page"
      title="Harness profiles"
      hint={
        <>
          A harness is the program a pane runs: pi or opencode. A harness profile is a named environment for
          one — model, effort, instructions, and which extensions, skills, packages and MCP servers a pane
          starts with; <code>basedOnHarnessProfile</code> names the profile it is layered on. Every Corvi pane
          gets a generated agent directory, and the resolved view beside the editor shows exactly what it will
          contain. <a href="/settings#harness-defaults">Harness profile defaults →</a>
        </>
      }
      empty="no harness profiles yet"
      repositoryHint={
        <>
          The harness profiles a change&apos;s checkouts carry (
          <code>&lt;checkout&gt;/.corvi/harnesses/&lt;id&gt;.md</code>) — a change with such a checkout can
          select them.
        </>
      }
      subjectNoun="harness profile"
      what="harness profile"
      templateFor={templateFor}
      Editor={HarnessProfileEditor}
    />
  );
}
