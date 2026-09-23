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
 * the file here are one file. Briefing the agent about it is the terminal page's action menu
 * (apps/web/src/actions/RunMenu.tsx), not this card's.
 */
export function PlanCard({
  changeId,
  readOnly = false,
}: {
  changeId: string;
  /** A finished change's plan is a record: readable, not editable. */
  readOnly?: boolean;
}): JSX.Element {
  const key = `${changeId}:plan`;
  const [text, setText] = useState<string>(() => cached<string>(key) ?? "");
  const [saved, setSaved] = useState(true);
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

  return (
    <section className="widget">
      <h3>
        Plan
        <span className="spacer" />
        <span className="summary">{saved ? "" : "unsaved"}</span>
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
