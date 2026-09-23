import { type JSX, useEffect, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { apiClient } from "../../app-root/api.ts";
import { cached, putCached } from "../../app-root/cache.ts";

/**
 * The plan of a change: the document the human and the agent shape before any work exists, and
 * that stays readable — and editable — once the work has started. It is the change's own file,
 * not a phase's, so it does not disappear when the state moves on.
 *
 * A textarea with the notes widget's contract — load, debounce, flush on blur and on unmount,
 * never overwrite what is being typed — because it is the same kind of thing. It reads and writes
 * `PLAN.md` at the change root through the change's own route, so the file the agent edits and
 * the file here are one file.
 *
 * The briefing button beside the heading pastes the configured prompt into the change's terminal,
 * and is offered only while the change is an idea: the prompt is about shaping a plan before the
 * work starts. Corvi cannot enforce "only the plan changes" (pi has no sandbox, and a symlinked
 * repository cannot be made read-only), so it says so to the agent instead.
 */
export function PlanCard({
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
  const key = `${changeId}:plan`;
  const [text, setText] = useState<string>(() => cached<string>(key) ?? "");
  const [saved, setSaved] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // Read by the unmount effect, which must not re-run on every keystroke.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    apiClient
      .plan(ChangeId.make(changeId))
      .then(({ text: fromDisk }) => {
        if (pending.current !== null) return; // do not overwrite what is being typed
        putCached(key, fromDisk ?? "");
        setText(fromDisk ?? "");
      })
      .catch(() => {});
  }, [changeId, key]);

  const save = (value: string): Promise<void> =>
    apiClient
      .writePlan(ChangeId.make(changeId), value)
      .then(() => {
        putCached(key, value);
        pending.current = null;
        setSaved(true);
      })
      .catch(() => setSaved(false));

  const change = (value: string): void => {
    setText(value);
    setSaved(false);
    pending.current = value;
  };

  // Debounced save; the cleanup also covers unmount, so leaving the page flushes.
  useEffect(() => {
    if (pending.current === null) return;
    const timer = setTimeout(() => void save(text), 800);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(
    () => () => {
      if (pending.current !== null) void save(pending.current);
    },
    [],
  );

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
    <section className="widget">
      <h3>
        Plan
        <span className="spacer" />
        {notice && <span className="summary">{notice}</span>}
        <span className="summary">{saved ? "" : "unsaved"}</span>
        {canBrief && (
          <button title="Paste the briefing prompt into this change's terminal" onClick={brief}>
            Brief the agent
          </button>
        )}
      </h3>
      <textarea
        className="plan"
        rows={16}
        value={text}
        readOnly={readOnly}
        placeholder="What this change is, and how it might work. The agent reads and edits this file (PLAN.md)."
        onChange={(e) => change(e.target.value)}
        onBlur={() => pending.current !== null && void save(text)}
      />
    </section>
  );
}
