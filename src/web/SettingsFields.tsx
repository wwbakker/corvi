import type { SettingsView } from "../settings.ts";
import type { JSX } from "react";

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
  locked,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  placeholder?: string;
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
        value={value ?? ""}
        placeholder={locked ? "" : placeholder}
        disabled={Boolean(locked)}
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
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  placeholder?: string;
  locked?: string;
  onChange: (values: string[]) => void;
}): JSX.Element {
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
    </Group>
  );
}
