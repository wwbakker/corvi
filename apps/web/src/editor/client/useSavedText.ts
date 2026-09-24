import { useCallback, useEffect, useRef, useState } from "react";
import { cached, putCached } from "../../app-root/cache.ts";
import { useServerEvent } from "../../app-root/events.ts";

/**
 * A text document's save contract — the one the plan and the notes share: load, debounce, flush
 * on blur and on unmount, and never overwrite what is being typed. The caller supplies the
 * reader and the writer; this owns the states between them.
 *
 * It also keeps the buffer honest about the disk. The document is read again when the window
 * comes back and when the server says something changed — an agent or an IDE editing the file
 * announces like a save does — and a read that finds new text applies it while nothing is being
 * typed. A save is based on the revision it read: a file that changed underneath is refused
 * rather than overwritten, and `stale` says so, with `reload` and `keepMine` as the two honest
 * answers.
 */

/** A document as it is read: its text (null is an empty document), and the revision that text
 * had — what later saves are based on. A caller that cannot version its document leaves it out;
 * saves then simply never conflict. */
export type SavedDoc = { text: string | null; revision?: string };

/** What a save answers: the revision the written text has — or "conflict", when the file
 * changed underneath and nothing was written. */
export type SaveOutcome = { revision?: string } | "conflict";

export function useSavedText({
  key,
  load,
  save: write,
}: {
  /** What the text is remembered under while the page is open — and what a reload is keyed by,
   * so it must change when the document does. */
  key: string;
  /** Read the document; its revision is what the next save is based on. */
  load: () => Promise<SavedDoc>;
  /** Write the document against the revision it was edited from; undefined writes
   * unconditionally. A rejection leaves the text unsaved rather than lost. */
  save: (value: string, baseRevision: string | undefined) => Promise<SaveOutcome>;
}): {
  /** The document as it stands: the remembered one first, then what was loaded or typed. */
  text: string;
  /** Every edit, saved a moment later. */
  change: (value: string) => void;
  /** Whether everything typed has been written. */
  saved: boolean;
  /** Save now if anything is unsaved: the editor's blur. */
  flush: () => void;
  /** The file changed on disk while edits are unsaved (or a save hit the change): one of the two
   * texts must go, and the banner asks which. */
  stale: boolean;
  /** Take the disk's text and drop the local edits. */
  reload: () => void;
  /** Deliberately write the local text over the disk. */
  keepMine: () => void;
} {
  const [text, setText] = useState<string>(() => cached<string>(key) ?? "");
  const [saved, setSaved] = useState(true);
  const [stale, setStale] = useState(false);
  // Read by the long-lived callbacks below, which must not close over a stale render's caller.
  const calls = useRef({ load, write });
  useEffect(() => {
    calls.current = { load, write };
  });
  // The revision the buffer is on: what its next save is based on.
  const revision = useRef<string | undefined>(undefined);
  // Read by the unmount effect, which must not re-run on every keystroke.
  const pending = useRef<string | null>(null);
  // The debounced save, while one is waiting: a write or a reload supersedes it, so it must be
  // cancellable — a write that lands after "Reload" would clobber exactly what it restored.
  const scheduled = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelScheduled = (): void => {
    if (scheduled.current !== undefined) {
      clearTimeout(scheduled.current);
      scheduled.current = undefined;
    }
  };
  // The newest read's identity: a slow one never overwrites a newer read or a fresh keystroke.
  const seen = useRef(0);

  /** Apply a document just read: it supersedes the buffer while nothing is being typed, and
   * marks the buffer stale when the disk moved and typing is in flight — never the other way
   * around. */
  const adopt = useCallback(
    (doc: SavedDoc): void => {
      if (pending.current !== null) {
        if (doc.revision !== undefined && doc.revision !== revision.current) setStale(true);
        return;
      }
      revision.current = doc.revision;
      const text = doc.text ?? "";
      putCached(key, text);
      setText(text);
      setSaved(true);
      setStale(false);
    },
    [key],
  );

  const refresh = useCallback((): void => {
    const mine = ++seen.current;
    calls.current
      .load()
      .then((doc) => {
        if (mine === seen.current) adopt(doc);
      })
      .catch(() => {});
  }, [adopt]);

  // Read on arrival, and whenever the world may have moved: the window coming back, or the
  // server saying the document changed (`/api/events` — an external edit announces like a save).
  useEffect(refresh, [key, refresh]);
  useServerEvent("changes", refresh);
  useEffect(() => {
    const onVisibility = (): void => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  /** Write one text out and take the revision it lands as the buffer's own. A conflict writes
   * nothing: the buffer keeps its edits and the banner asks. Any debounced write is superseded
   * by this one — whoever asked for the write answers for it now. */
  const writeOut = (value: string, base: string | undefined): Promise<void> => {
    cancelScheduled();
    return calls.current
      .write(value, base)
      .then((outcome) => {
        if (outcome === "conflict") {
          setStale(true);
          return;
        }
        if (outcome.revision !== undefined) revision.current = outcome.revision;
        putCached(key, value);
        // What was written is what the buffer holds — unless a keystroke landed while the write
        // was in flight, in which case that newer text stays unsaved (and stays pending).
        if (pending.current === value) {
          pending.current = null;
          setSaved(true);
        }
        setStale(false);
      })
      .catch(() => setSaved(false));
  };

  const change = (value: string): void => {
    setText(value);
    setSaved(false);
    pending.current = value;
  };

  // Debounced save; the cleanup also covers unmount, so leaving the page flushes.
  useEffect(() => {
    if (pending.current === null) return;
    cancelScheduled();
    scheduled.current = setTimeout(() => {
      scheduled.current = undefined;
      if (pending.current !== null) void writeOut(pending.current, revision.current);
    }, 800);
    return cancelScheduled;
  }, [text]);

  useEffect(
    () => () => {
      cancelScheduled();
      if (pending.current !== null) void writeOut(pending.current, revision.current);
    },
    [],
  );

  const flush = (): void => {
    if (pending.current !== null) void writeOut(text, revision.current);
  };

  // Drop the local edits and take the disk's text. The banner answers first and closes when
  // the text is actually in hand — adopt does both at once.
  const reload = (): void => {
    cancelScheduled();
    pending.current = null;
    setSaved(true);
    refresh();
  };

  // Deliberately write the local text over the disk; the banner closes when it has landed.
  const keepMine = (): void => {
    void writeOut(text, undefined);
  };

  return { text, change, saved, flush, stale, reload, keepMine };
}
