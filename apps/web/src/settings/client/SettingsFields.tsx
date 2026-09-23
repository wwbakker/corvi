import type { SettingsView } from "../model.ts";
import { useState, type JSX } from "react";
import { DirectoryPicker } from "../../workspace/client/DirectoryPicker.tsx";

/** An extension the page knows about, with the settings it declares. */
export type KnownExtension = SettingsView["extensions"][number];

/**
 * A labelled control in the settings form: an input, with the value that applies anyway as its
 * placeholder, and the environment variable named when one is overriding it.
 */
export function Field({
  label,
  hint,
  value,
  placeholder,
  secret,
  locked,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  placeholder?: string;
  /** A value the page is not trusted with: drawn as a password, which is what it is. To the page
   * it is an opaque string — the server sent a mask and keeps what it holds when the mask comes
   * back (`apps/server/src/settings/server/secrets.ts`). */
  secret?: boolean;
  /** The environment variable overriding this, when there is one. */
  locked?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label>
      <span>
        {label}
        {locked && <span className="locked"> — set by {locked}</span>}
      </span>
      <input
        type={secret ? "password" : "text"}
        value={value ?? ""}
        placeholder={locked ? "" : placeholder}
        disabled={Boolean(locked)}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * A directory setting: the same input as `Field`, with a picker built from the repository
 * browser's listing. Typing stays possible — a `~` path, or one that does not exist yet — and
 * has the same effect as choosing, because the field is the setting and the picker is an aid.
 *
 * `workspace` is the context whose repositories directory the picker opens on when the field is
 * empty; the picker falls back to the server's own idea of where browsing starts.
 */
export function DirectoryField({
  label,
  hint,
  value,
  placeholder,
  locked,
  workspace,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  placeholder?: string;
  /** The environment variable overriding this, when there is one. */
  locked?: string;
  /** Which context's repositories directory the picker opens on. */
  workspace?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  // A div rather than a <label>: the Browse button inside one would be named by the label
  // instead of by its own text, the same trap `Group` documents. The input carries the label as
  // its accessible name instead.
  return (
    <div className="field">
      <span className="label">
        {label}
        {locked && <span className="locked"> — set by {locked}</span>}
      </span>
      <div className="row">
        <input
          aria-label={label}
          value={value ?? ""}
          placeholder={locked ? "" : placeholder}
          disabled={Boolean(locked)}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="choose"
          title="browse for a directory"
          disabled={Boolean(locked)}
          onClick={() => setOpen(true)}
        >
          Browse…
        </button>
      </div>
      {hint && <small>{hint}</small>}
      <DirectoryPicker
        open={open}
        onClose={() => setOpen(false)}
        path={value?.trim() ? value : undefined}
        workspace={workspace}
        onChoose={onChange}
      />
    </div>
  );
}

/**
 * A multi-line field: for prose rather than a value, such as the prompt that briefs an agent.
 * Grows with its content by the browser's own sizing rules, and takes the full width of the form.
 */
export function TextArea({
  label,
  hint,
  value,
  placeholder,
  rows = 6,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  placeholder?: string;
  rows?: number;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <textarea
        rows={rows}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** A checkbox: a decision rather than a value, so it is its own control beside its name. */
export function CheckField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/**
 * A heading over several controls.
 *
 * Not a `<label>`: a label names exactly one control, and a `<button>` inside one is named by it
 * rather than by its own text — which makes "+ add" unclickable by name and, more to the point,
 * unannounceable to anything that reads the page aloud.
 */
export function Group({
  label,
  hint,
  locked,
  children,
}: {
  label: string;
  hint?: string;
  locked?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="field">
      <span className="label">
        {label}
        {locked && <span className="locked"> — set by {locked}</span>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** A list of short strings — directories to copy, environments in deployment order. Rows rather
 * than a comma-separated box: the order matters for one of them, and a typo in a comma list is
 * hard to see. */
export function ListEditor({
  label,
  hint,
  values,
  placeholder,
  locked,
  picker = false,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  placeholder?: string;
  locked?: string;
  /** Whether a row may be filled by browsing: a directory list, as opposed to a list of names or
   * environments, where a picker could only offer the wrong kind of value. */
  picker?: boolean;
  onChange: (values: string[]) => void;
}): JSX.Element {
  const [picking, setPicking] = useState<number>();
  const set = (index: number, value: string): void =>
    onChange(values.map((v, i) => (i === index ? value : v)));

  return (
    <Group label={label} hint={hint} locked={locked}>
      {values.map((value, index) => (
        <div className="row" key={index}>
          <input
            value={value}
            placeholder={placeholder}
            disabled={Boolean(locked)}
            onChange={(e) => set(index, e.target.value)}
          />
          {picker && !locked && (
            <button
              type="button"
              className="choose"
              title="browse for a directory"
              onClick={() => setPicking(index)}
            >
              …
            </button>
          )}
          <button
            className="remove"
            title="remove"
            disabled={Boolean(locked)}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      {!locked && (
        <button className="add" onClick={() => onChange([...values, ""])}>
          + add
        </button>
      )}
      {picker && (
        <DirectoryPicker
          open={picking !== undefined}
          onClose={() => setPicking(undefined)}
          path={picking !== undefined ? values[picking] : undefined}
          onChoose={(dir) => picking !== undefined && set(picking, dir)}
        />
      )}
    </Group>
  );
}
