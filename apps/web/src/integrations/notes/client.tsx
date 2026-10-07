import { type JSX } from "react";
import { TextSchema } from "@corvi/contracts/api";
import { changeKey, useChangeWireClient, useSource, useSourceAvailability } from "../../app-root/sources.ts";
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
  // The change's source, so a remote change's notes are read and written on the server that
  // owns them.
  const wire = useChangeWireClient();
  // The cached draft is keyed by source too: two servers can mint the same change id, and their
  // notes are not the same notes.
  const source = useSource();
  // The generation is part of the key: a same-id retarget must not show (or later save) the old
  // target's draft under the change id the two targets share. The reachability is what makes the
  // retained notes read-only and holds their saves back: a contenteditable editor is not a form
  // control, so the dashboard's disabled fieldset never reaches it.
  const availability = useSourceAvailability(source);
  const generation = availability.generation;
  const blocked = availability.status._tag !== "available";
  const { text, change, saved, flush, stale, reload, keepMine } = useSavedText({
    key: `${changeKey(source, changeId)}@${generation}:notes`,
    canSave: !blocked,
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
        readOnly={blocked}
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
