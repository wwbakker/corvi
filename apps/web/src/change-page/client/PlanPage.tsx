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
 * The briefing button in the toolbar pastes the configured prompt into the change's terminal,
 * and is offered only while the change is an idea: the prompt is about shaping a plan before the
 * work starts. Corvi cannot enforce "only the plan changes" (pi has no sandbox, and a symlinked
 * repository cannot be made read-only), so it says so to the agent instead.
 */
export function PlanPage({
  changeId,
  canBrief,
  readOnly = false,
}: {
  changeId: string;
  /** Whether the change is still an idea: the briefing prompt belongs to that phase. */
  canBrief: boolean;
  /** A finished change's plan is a record: readable, not editable. */
  readOnly?: boolean;
}): JSX.Element {
  const { text, change, saved, flush } = useSavedText({
    key: `${changeId}:plan`,
    load: () => apiClient.plan(ChangeId.make(changeId)).then(({ text }) => text ?? null),
    save: (value) => apiClient.writePlan(ChangeId.make(changeId), value),
  });
  const [notice, setNotice] = useState<string | null>(null);

  /** Paste the briefing into the change's terminal. The session is created if it is not up yet,
   * so this works without opening the terminal first; the text is not submitted — the agent's
   * editor holds it for you to read. */
  const brief = (): void => {
    apiClient
      .briefAgent(ChangeId.make(changeId))
      .then(() => {
        setNotice("Prompt pasted into the terminal");
        setTimeout(() => setNotice(null), 2500);
      })
      .catch((e: Error) => setNotice(e.message));
  };

  return (
    <section className="plan-page">
      <div className="plan-toolbar">
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
        <span className="summary">{saved ? "" : "unsaved"}</span>
        {canBrief && (
          <button title="Paste the briefing prompt into this change's terminal" onClick={brief}>
            Brief the agent
          </button>
        )}
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
