import { type JSX, useEffect, useRef, useState } from "react";
import { makeWireClient } from "@corvi/client";
import { TextSchema } from "@corvi/contracts/api";
import { cached, putCached } from "../../app-root/cache.ts";
import { MarkdownEditor } from "../../editor/client/MarkdownEditor.tsx";
import type { WidgetComponent } from "../client.tsx";

/**
 * The notes extension's browser half: the change's Notes widget on its dashboard. The widget
 * contract hands it the change and its workspace, and the component below is the notes card
 * that used to sit on the dashboard — same debounce, same unsaved marker — written in the shared
 * Markdown source editor and reading and writing the extension's own routes. The editor's
 * keymap takes Home and End to the line's edges on every platform, which is what the card used
 * to implement by hand — WebKit takes them to the document's edges instead, and in a long note
 * that is almost never where you wanted the caret to go.
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
      <MarkdownEditor
        rows={20}
        value={text}
        placeholder="Anything worth remembering about this change."
        onChange={change}
        onBlur={() => pending.current !== null && void save(text)}
      />
    </section>
  );
}

export const widget: WidgetComponent = ({ change, workspace }) => (
  <NotesCard changeId={change.id} workspace={workspace} />
);
