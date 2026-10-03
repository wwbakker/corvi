import { type JSX, useEffect, useRef, useState } from "react";

/** One built-in as the picker lists it: the file's id, its label, and the text a copy carries. */
export type Template = {
  readonly id: string;
  readonly label?: string;
  readonly text: string;
};

/** The body's first line, as the row's one-line description. */
const firstLine = (text: string): string => {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
};

/**
 * The create flow: a template picker, then the id. **Blank** starts from the smallest file that
 * parses; a built-in is copied whole — the effective text, the brief's legacy override included
 * — and the id defaults to the template's, so the copy shadows the shipped file while it exists.
 * Creating is writing the first version of the file in the chosen scope; the page does that and
 * opens the editor on it.
 */
export function TemplatePicker({
  what,
  templates,
  blank,
  onCreate,
  onClose,
}: {
  /** What is being created ("action" / "profile"), for the dialog's words. */
  what: string;
  /** The built-in files, as the listing returns them — the templates to copy. */
  templates: readonly Template[];
  /** The blank start for this family, given the id the user typed. */
  blank: (id: string) => string;
  /** Write the file: its id and the text it starts from. */
  onCreate: (id: string, text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState<string>("blank");
  const [id, setId] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  const template = templates.find((one) => one.id === chosen);
  const text = template === undefined ? blank(id) : template.text;

  return (
    <dialog
      ref={ref}
      className="template-picker"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h3>New {what}</h3>
      <p className="hint">
        Start blank, or copy a built-in. The copy lands in this scope and shadows the built-in
        while it exists.
      </p>
      <div className="template-choices">
        <button
          type="button"
          className={`template-choice${chosen === "blank" ? " current" : ""}`}
          onClick={() => {
            setChosen("blank");
            setId("");
          }}
        >
          <strong>Blank</strong>
          <span className="summary">the smallest file that parses</span>
        </button>
        {templates.map((one) => (
          <button
            type="button"
            key={one.id}
            className={`template-choice${chosen === one.id ? " current" : ""}`}
            onClick={() => {
              setChosen(one.id);
              setId(one.id);
            }}
          >
            <strong>{one.label ?? one.id}</strong>
            <span className="summary">{firstLine(one.text)}</span>
          </button>
        ))}
      </div>
      <pre className="template-preview">{text}</pre>
      <div className="dialog-actions">
        <input
          value={id}
          placeholder={`new-${what}`}
          aria-label={`new ${what} id`}
          onChange={(e) => setId(e.target.value.trim())}
        />
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="create"
          disabled={!id}
          onClick={() => onCreate(id, text)}
        >
          Create
        </button>
      </div>
    </dialog>
  );
}
