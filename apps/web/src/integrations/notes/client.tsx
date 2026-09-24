import { type JSX } from "react";
import { makeWireClient } from "@corvi/client";
import { TextSchema } from "@corvi/contracts/api";
import { MarkdownEditor } from "../../editor/client/MarkdownEditor.tsx";
import { useSavedText } from "../../editor/client/useSavedText.ts";
import type { WidgetComponent } from "../client.tsx";

/**
 * The notes extension's browser half: the change's Notes widget on its dashboard. The widget
 * contract hands it the change and its workspace, and the component below is the notes card
 * that used to sit on the dashboard — the plan's save contract (useSavedText) and the plan's
 * editor (MarkdownEditor) — reading and writing the extension's own routes. The editor's
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
  // The same notes are read and written through the extension's namespace, as the change's
  // workspace, so the server resolves the change from the right root.
  const endpoint = url(`/ext/notes/changes/${changeId}/notes`, workspace);
  const { text, change, saved, flush, stale, reload, keepMine } = useSavedText({
    key: `${changeId}:notes`,
    load: () =>
      wire
        .request("GET", endpoint, TextSchema)
        .then(({ text }) => ({ text: text ?? null })),
    // The notes route has no revision to save against: its saves cannot conflict, and a file
    // changed underneath is only ever caught by the re-reads (useSavedText).
    save: (value) =>
      wire.request("PUT", endpoint, TextSchema, { body: { text: value } }).then(() => ({})),
  });

  return (
    <section className="widget">
      <h3>
        Notes
        <span className="spacer" />
        <span className="summary">{saved ? "" : "unsaved"}</span>
      </h3>
      {stale && (
        <div className="stale-banner">
          <span>The notes changed on disk.</span>
          <button type="button" title="drop these edits and load the file" onClick={reload}>
            Reload
          </button>
          <button
            type="button"
            title="overwrite the file with what is here"
            onClick={keepMine}
          >
            Keep mine
          </button>
        </div>
      )}
      <MarkdownEditor
        rows={20}
        value={text}
        placeholder="Anything worth remembering about this change."
        onChange={change}
        onBlur={flush}
      />
    </section>
  );
}

export const widget: WidgetComponent = ({ change, workspace }) => (
  <NotesCard changeId={change.id} workspace={workspace} />
);
