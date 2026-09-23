import { type JSX, useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  EditorView,
  crosshairCursor,
  highlightActiveLine,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  keymap,
  placeholder as placeholderExtension,
  rectangularSelection,
  scrollPastEnd,
} from "@codemirror/view";
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
  fill = false,
  onBlur,
}: {
  /** The document; applied whenever it differs from what the editor holds. */
  value: string;
  /** Every edit, as the whole document. */
  onChange: (value: string) => void;
  /** A finished change's plan is a record: readable, not editable. */
  readOnly?: boolean;
  placeholder?: string;
  /** The height the editor opens at, in text lines; long documents scroll inside it. The box's
   * corner drags it taller. */
  rows?: number;
  /** Take the container's height instead of a rows-sized one: a tab that hands the editor its
   * whole frame. */
  fill?: boolean;
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
          // The affordances a source editor has, none of them new weight: a heading's section or
          // a table folds at its gutter mark; Ctrl-F finds and replaces and Ctrl-D selects the
          // next occurrence (the panel opens at the bottom, under the plan's floating toolbar);
          // brackets close and match; the caret's line is lit and the characters you cannot see
          // — tabs, control characters, trailing spaces — are drawn.
          codeFolding(),
          foldGutter(),
          search(),
          highlightSelectionMatches(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSpecialChars(),
          highlightTrailingWhitespace(),
          rectangularSelection(),
          crosshairCursor(),
          scrollPastEnd(),
          keymap.of([
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
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
      className={fill ? "md-editor fill" : "md-editor"}
      ref={host}
      style={fill ? undefined : { height: `calc(${rows} * 1.5em + 18px)` }}
    />
  );
}
