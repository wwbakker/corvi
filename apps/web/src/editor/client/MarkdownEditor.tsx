import { type JSX, useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  insertTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentUnit,
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
import { scrollOf, seeScroll, type DocumentKey } from "../../app-root/remember.ts";

/** Read-only is a prop that changes (a finished change's plan is a record), so it lives in a
 * compartment the view can be reconfigured through. */
const readOnlyCompartment = new Compartment();

/** Tab inserts a tab and Shift-Tab takes one out, consuming the keystroke instead of moving to
 * the next control. Read-only text has nothing to insert, so the keystroke falls through to the
 * browser — the record is still left by keyboard. The way out of an editable editor is the
 * platform's own: Escape arms tab-focus mode for two seconds (`@codemirror/view`), in which the
 * next Tab moves on instead of indenting. */
const tabKeys = (view: EditorView): boolean => (view.state.readOnly ? false : insertTab(view));
const shiftTabKeys = (view: EditorView): boolean => (view.state.readOnly ? false : indentLess(view));

/**
 * The Markdown source editor the plan, the notes and the wizard's description are written in: a
 * CodeMirror 6 view with the Markdown grammar, syntax coloring (theme.ts), and the monospace
 * face of a source file. Every character of the markup stays visible and editable — this colors
 * the source, it does not render it.
 *
 * The view owns the document while it is being typed in; an external `value` is applied only
 * when it differs from the document, so a late load cannot jump the caret out of a sentence.
 * Callers keep their own save contract (load, debounce, flush): this only reports edits and
 * focus loss. Where the caret is comes out too (`onCaret`), for callers that read the document
 * as they go — the action editor follows its fields with it. Home and End move between line
 * edges, which is what `@codemirror/commands`'
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
  onCaret,
  remember,
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
  /** The caret moved to another line: its 1-based number, as the document is edited or the
   * caret travels. The caret is on line 1 until it moves, which is not reported. */
  onCaret?: (line: number) => void;
  /** Come back to this document where you left it: the key its scroll position is remembered
   * under (app-root/remember.ts — remembered while the page lives, forgotten by a restart). */
  remember?: DocumentKey;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<EditorView | null>(null);
  // Read by the view's long-lived callbacks, which must not close over a stale render's handlers.
  const events = useRef({ onChange, onBlur, onCaret });
  // The line last reported, so a caret travelling inside one line is no news.
  const caretLine = useRef(1);
  // Set while an external `value` is applied to the document: that dispatch is this component
  // writing, not a person typing, and reporting it would mark a just-loaded document unsaved —
  // and, in the save contract, "being typed in".
  const applying = useRef(false);
  // Which key's scroll is being remembered now — the prop may follow the document to another
  // change while the view lives — and which view has taken that key's position: the view is
  // rebuilt around the same document (React re-runs the creating effect), and the rebuilt one
  // must restore again and settle again before its scroll is worth recording. Keyed by the
  // view, not by the component, so a rebuilt view is a fresh subject.
  const memory = useRef(remember);
  memory.current = remember;
  const restored = useRef<{ view: EditorView; key: string } | null>(null);
  const settled = useRef<{ view: EditorView; key: string } | null>(null);
  useEffect(() => {
    events.current = { onChange, onBlur, onCaret };
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
          // Tab inserts a literal tab character (a selection indents by the same unit), and the
          // keystroke is consumed — Escape-then-Tab is what moves focus out.
          indentUnit.of("\t"),
          keymap.of([
            { key: "Tab", run: tabKeys, shift: shiftTabKeys },
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
            if (update.docChanged && !applying.current) {
              events.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const line = update.state.doc.lineAt(update.state.selection.main.head).number;
              if (line !== caretLine.current) {
                caretLine.current = line;
                events.current.onCaret?.(line);
              }
            }
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
    // Where the reader was, in the remembered document (remember.ts): recorded as the view
    // scrolls, and restored on arrival below. A view still filling with text — or one already
    // taken off the page, whose detached scroller reads zero again — records nothing: only a
    // settled, attached view's position is worth remembering.
    const saveScroll = (): void => {
      const key = memory.current;
      if (key !== undefined && settled.current?.view === view && settled.current.key === key) {
        seeScroll(key, view.scrollDOM.scrollTop);
      }
    };
    view.scrollDOM.addEventListener("scroll", saveScroll);
    return () => {
      if (view.scrollDOM.isConnected) saveScroll();
      view.scrollDOM.removeEventListener("scroll", saveScroll);
      view.destroy();
      editor.current = null;
    };
    // Mount once: prop changes are applied below, to the view that exists.
  }, []);

  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    if (view.state.doc.toString() !== value) {
      applying.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      applying.current = false;
    }
    // Where this key's reader left it comes back once the view is next measured — the scroller
    // has no height to scroll before it is laid out, and an earlier scrollTop would clamp to
    // zero. A document nothing is remembered of keeps whatever scroll it has. That measurement
    // is also when the view settles on the key and its scroll starts being recorded. Once per
    // view and key: the key may follow the editor to another change while the view lives.
    const key = remember;
    if (key !== undefined && (restored.current?.view !== view || restored.current.key !== key)) {
      restored.current = { view, key };
      view.requestMeasure({
        read: () => scrollOf(key),
        write: (top) => {
          settled.current = { view, key };
          if (top !== undefined) view.scrollDOM.scrollTop = top;
        },
      });
    }
  }, [value, remember]);

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
