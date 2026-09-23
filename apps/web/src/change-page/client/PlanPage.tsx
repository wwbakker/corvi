import { type JSX, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { apiClient } from "../../app-root/api.ts";
import { MarkdownEditor } from "../../editor/client/MarkdownEditor.tsx";
import { useSavedText } from "../../editor/client/useSavedText.ts";

/**
 * The plan of a change: the document the human and the agent shape before any work exists, and
 * that stays readable — and editable — once the work has started. It is the change's own file,
 * not a phase's, so it does not disappear when the state moves on. Its own tab, and the tab's
 * frame: the source fills it, a document of the change rather than a card beside its status.
 *
 * The Markdown source editor over the save contract the notes share (useSavedText) — load,
 * debounce, flush on blur and on unmount, never overwrite what is being typed. It reads and
 * writes `PLAN.md` at the change root through the change's own route, so the file the agent
 * edits and the file here are one file.
 *
 * Briefing the agent about it is the terminal page's action menu
 * (apps/web/src/actions/RunMenu.tsx), not this page's.
 */
export function PlanPage({
  changeId,
  readOnly = false,
}: {
  changeId: string;
  /** A finished change's plan is a record: readable, not editable. */
  readOnly?: boolean;
}): JSX.Element {
  const { text, change, saved, flush } = useSavedText({
    key: `${changeId}:plan`,
    load: () => apiClient.plan(ChangeId.make(changeId)).then(({ text }) => text ?? null),
    save: (value) => apiClient.writePlan(ChangeId.make(changeId), value),
  });
  return (
    <section className="plan-page">
      <div className="plan-toolbar">
        <span className="spacer" />
        <span className="summary">{saved ? "" : "unsaved"}</span>
      </div>
      <MarkdownEditor
        fill
        value={text}
        readOnly={readOnly}
        placeholder="What this change is, and how it might work. The agent reads and edits this file (PLAN.md)."
        onChange={change}
        onBlur={flush}
      />
    </section>
  );
}
