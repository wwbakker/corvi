/** The Harnesses page: the named, file-defined Pi environments, one row per file by scope. The
 * shared FileListPage holds the list/editor/create frame; the editor carries the resolved view. */
import { type JSX } from "react";

import { apiClient } from "../app-root/api.ts";
import { FileListPage } from "../app-root/FileListPage.tsx";
import type { LeaveGuard } from "../app-root/navigation.ts";
import { HarnessEditor } from "./HarnessEditor.tsx";

/** A new harness starts as the smallest file that parses: a label and a base. */
const templateFor = (id: string): string => `---\nlabel: ${id}\nharness: pi\n---\n`;

export function HarnessesPage({ onGuard }: { onGuard: (guard: LeaveGuard | null) => void }): JSX.Element {
  return (
    <FileListPage
      onGuard={onGuard}
      api={apiClient.harnesses}
      view="harnesses"
      pageClass="harnesses-page"
      title="Harnesses"
      hint={
        <>
          A harness is a named Pi environment: agent, model, effort, instructions, and which extensions,
          skills, packages and MCP servers a pane starts with. Every Corvi pane gets a generated agent
          directory; the resolved view beside the editor shows exactly what it will contain.{" "}
          <a href="/settings#harness-defaults">Harness defaults →</a>
        </>
      }
      empty="no harnesses yet"
      repositoryHint={
        <>
          The harnesses a change&apos;s checkouts carry (
          <code>&lt;checkout&gt;/.corvi/harnesses/&lt;id&gt;.md</code>) — a change with such a checkout can
          select them.
        </>
      }
      subjectNoun="harness"
      what="harness"
      templateFor={templateFor}
      Editor={HarnessEditor}
    />
  );
}
