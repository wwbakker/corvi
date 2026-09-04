import { useEffect, useRef, useState } from "react";
import { api, put } from "./api.ts";
import { cached, putCached } from "./cache.ts";

/**
 * Free-text notes for a change, stored beside change.json. Saved a moment after you stop typing
 * and again when the card goes away, so navigating off does not lose the last sentence.
 */
export function NotesCard({ changeId }: { changeId: string }) {
  const key = `${changeId}:notes`;
  const [text, setText] = useState<string>(() => cached<string>(key) ?? "");
  const [saved, setSaved] = useState(true);
  // Read by the unmount effect, which must not re-run on every keystroke.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    api<{ text: string }>(`/changes/${changeId}/notes`)
      .then(({ text: loaded }) => {
        if (pending.current !== null) return; // do not overwrite what is being typed
        putCached(key, loaded);
        setText(loaded);
      })
      .catch(() => {});
  }, [changeId]);

  const save = (value: string): Promise<void> =>
    put<{ text: string }>(`/changes/${changeId}/notes`, { text: value })
      .then(() => {
        putCached(key, value);
        pending.current = null;
        setSaved(true);
      })
      .catch(() => setSaved(false));

  const change = (value: string) => {
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
        Notes
        <span className="spacer" />
        <span className="summary">{saved ? "" : "unsaved"}</span>
      </h3>
      <textarea
        className="notes"
        rows={20}
        value={text}
        placeholder="Anything worth remembering about this change."
        onChange={(e) => change(e.target.value)}
        onBlur={() => pending.current !== null && void save(text)}
      />
    </section>
  );
}
