import { type JSX, useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { editorChrome, markdownHighlighting } from "./theme.ts";
import { fencedCodeLanguages } from "./languages.ts";

/** Read-only is a prop that changes (a finished change's plan is a record), so it lives in a
 * compartment the view can be reconfigured through. */
const readOnlyCompartment = new Compartment();

/**
 * The Markdown source editor the plan, the notes and the wizard's description are written in: a
 * CodeMirror 6 view with the Markdown grammar, syntax coloring (theme.ts), and the monospace
 * face of a source file. Every character of the markup stays visible and editable — this colors
 * the source, it does not render it.
 *
 * The view owns the document while it is being typed in; an external `value` is applied only
 * when it differs from the document, so a late load cannot jump the caret out of a sentence.
 * Callers keep their own save contract (load, debounce, flush): this only reports edits and
 * focus loss. Home and End move between line edges, which is what `@codemirror/commands`'
 * standard keymap binds on every platform — the behavior the notes widget used to implement
 * by hand.
 */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  rows = 16,
  onBlur,
}: {
  /** The document; applied whenever it differs from what the editor holds. */
  value: string;
  /** Every edit, as the whole document. */
  onChange: (value: string) => void;
  /** A finished change's plan is a record: readable, not editable. */
  readOnly?: boolean;
  placeholder?: string;
  /** The height the editor opens at, in text lines; long documents scroll inside it. */
  rows?: number;
  /** The editor lost focus: a card flushes its pending save here. */
  onBlur?: () => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<EditorView | null>(null);
  // Read by the view's long-lived callbacks, which must not close over a stale render's handlers.
  const events = useRef({ onChange, onBlur });
  useEffect(() => {
    events.current = { onChange, onBlur };
  });

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: fencedCodeLanguages }),
          syntaxHighlighting(markdownHighlighting),
          editorChrome,
          placeholder === undefined ? [] : placeholderExtension(placeholder),
          readOnlyCompartment.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) events.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              events.current.onBlur?.();
              return false;
            },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
    // Mount once: prop changes are applied below, to the view that exists.
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    editor.current?.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return (
    <div
      className="md-editor"
      ref={host}
      style={{ height: `calc(${rows} * 1.5em + 18px)` }}
    />
  );
}
