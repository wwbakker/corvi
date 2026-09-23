import { type JSX, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { makeWireClient } from "@corvi/client";
import { TextSchema } from "@corvi/contracts/api";
import { cached, putCached } from "../../app-root/cache.ts";
import type { WidgetComponent } from "../client.tsx";

/**
 * The notes extension's browser half: the change's Notes widget on its dashboard. The widget
 * contract hands it the change and its workspace, and the component below is the notes card
 * that used to sit on the dashboard — same debounce, same unsaved marker, same line-edge Home
 * and End — reading and writing the extension's own routes.
 */

/** The extension's routes live under its own namespace, and the request names the workspace the
 * change belongs to. */
const url = (path: string, workspace?: string): string =>
  workspace ? `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}` : path;

/** The transport: the same classified `ClientError` as the core client, with the DTO this
 * extension owns. */
const wire = makeWireClient({ baseUrl: "" });

/**
 * Free-text notes for a change. Saved a moment after you stop typing and again when the widget
 * goes away, so navigating off does not lose the last sentence.
 */
export function NotesCard({
  changeId,
  workspace,
}: {
  changeId: string;
  workspace?: string;
}): JSX.Element {
  const key = `${changeId}:notes`;
  const [text, setText] = useState<string>(() => cached<string>(key) ?? "");
  const [saved, setSaved] = useState(true);
  // Read by the unmount effect, which must not re-run on every keystroke.
  const pending = useRef<string | null>(null);
  // The same notes are read and written through the extension's namespace, as the change's
  // workspace, so the server resolves the change from the right root.
  const endpoint = url(`/ext/notes/changes/${changeId}/notes`, workspace);

  useEffect(() => {
    wire
      .request("GET", endpoint, TextSchema)
      .then(({ text: loaded }) => {
        if (pending.current !== null) return; // do not overwrite what is being typed
        putCached(key, loaded ?? "");
        setText(loaded ?? "");
      })
      .catch(() => {});
  }, [endpoint, key]);

  const save = (value: string): Promise<void> =>
    wire
      .request("PUT", endpoint, TextSchema, { body: { text: value } })
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

  /** Home and End as macOS text views mean them — the line's edges, which is also what
   * Cmd-Left and Cmd-Right do. WebKit gives them the whole note's edges instead, which in a
   * long note is almost never where you wanted the caret to go. */
  const lineEdge = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.currentTarget;
    const caret = el.selectionStart ?? 0;
    let at: number;
    if (e.key === "Home") {
      at = el.value.lastIndexOf("\n", caret - 1) + 1;
    } else if (e.key === "End") {
      const next = el.value.indexOf("\n", caret);
      at = next === -1 ? el.value.length : next;
    } else {
      return;
    }
    e.preventDefault();
    if (!e.shiftKey) {
      el.setSelectionRange(at, at);
      return;
    }
    // Shift extends the selection, as it does for the native chords: the other end stays put.
    const anchor =
      el.selectionDirection === "backward" ? (el.selectionEnd ?? 0) : (el.selectionStart ?? 0);
    const [from, to] = anchor < at ? [anchor, at] : [at, anchor];
    el.setSelectionRange(from, to, anchor < at ? "forward" : "backward");
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
        onKeyDown={lineEdge}
        onBlur={() => pending.current !== null && void save(text)}
      />
    </section>
  );
}

export const widget: WidgetComponent = ({ change, workspace }) => (
  <NotesCard changeId={change.id} workspace={workspace} />
);
