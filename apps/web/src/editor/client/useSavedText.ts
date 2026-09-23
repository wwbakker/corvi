import { useEffect, useRef, useState } from "react";
import { cached, putCached } from "../../app-root/cache.ts";

/**
 * A text document's save contract — the one the plan and the notes share: load, debounce, flush
 * on blur and on unmount, and never overwrite what is being typed. The caller supplies the
 * reader and the writer; this owns the states between them.
 */
export function useSavedText({
  key,
  load,
  save: write,
}: {
  /** What the text is remembered under while the page is open — and what a reload is keyed by,
   * so it must change when the document does. */
  key: string;
  /** Read the document; null is an empty one. */
  load: () => Promise<string | null>;
  /** Write the document; a rejection leaves the text unsaved rather than lost. */
  save: (value: string) => Promise<unknown>;
}): {
  /** The document as it stands: the remembered one first, then what was loaded or typed. */
  text: string;
  /** Every edit, saved a moment later. */
  change: (value: string) => void;
  /** Whether everything typed has been written. */
  saved: boolean;
  /** Save now if anything is unsaved: the editor's blur. */
  flush: () => void;
} {
  const [text, setText] = useState<string>(() => cached<string>(key) ?? "");
  const [saved, setSaved] = useState(true);
  // Read by the unmount effect, which must not re-run on every keystroke.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    load()
      .then((fromDisk) => {
        if (pending.current !== null) return; // do not overwrite what is being typed
        putCached(key, fromDisk ?? "");
        setText(fromDisk ?? "");
      })
      .catch(() => {});
  }, [key]);

  const save = (value: string): Promise<void> =>
    write(value)
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

  const flush = (): void => {
    if (pending.current !== null) void save(text);
  };

  return { text, change, saved, flush };
}
