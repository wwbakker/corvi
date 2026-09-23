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

/** A checkbox: a decision rather than a value, so it is its own control beside its name. In a
 * workspace the decision may be the global one — `note` says so and `onInherit` gives it back. */
export function CheckField({
  label,
  hint,
  checked,
  note,
  onInherit,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  /** What the checked box means when it is not this scope's own decision — "inherited: On". */
  note?: string;
  /** Drop this scope's decision and inherit the global one again. Absent at the global scope,
   * where there is nothing to inherit. */
  onInherit?: () => void;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {note && <span className="locked"> — {note}</span>}
        {hint && <small>{hint}</small>}
        {onInherit && (
          <small>
            <button type="button" className="link" onClick={onInherit}>
              use Global&apos;s
            </button>
          </small>
        )}
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
  note,
  onInherit,
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
  /** What the rows mean when they are not this scope's own decision — "inherited from Global". */
  note?: string;
  /** Drop this scope's list and inherit the global one again. Absent at the global scope, where
   * there is nothing to inherit. */
  onInherit?: () => void;
  onChange: (values: string[]) => void;
}): JSX.Element {
  const [picking, setPicking] = useState<number>();
  const set = (index: number, value: string): void =>
    onChange(values.map((v, i) => (i === index ? value : v)));

  return (
    <Group label={label} hint={hint} locked={locked}>
      {note && (
        <small className="hint">
          {note}
          {onInherit && " — "}
          {onInherit && (
            <button type="button" className="link" onClick={onInherit}>
              use Global&apos;s
            </button>
          )}
        </small>
      )}
      {!note && onInherit && (
        <small className="hint">
          <button type="button" className="link" onClick={onInherit}>
            use Global&apos;s
          </button>
        </small>
      )}
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

/**
 * The environment a scope adds to every CLI run: how two clients stop fighting over one login.
 * Names and values, because that is what it is — `GH_CONFIG_DIR` for another GitHub account,
 * `AZURE_CONFIG_DIR` for another tenant, `JIRA_API_TOKEN` for another site.
 *
 * The global entries ride along under a workspace's own rows, read-only: a key the workspace
 * sets wins, so its row is the one that shows.
 */
export function EnvEditor({
  env,
  inherited = {},
  onChange,
}: {
  env: Record<string, string>;
  /** The entries this scope inherits (the global level's, inside a workspace). */
  inherited?: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}): JSX.Element {
  const entries = Object.entries(env);
  const write = (pairs: [string, string][]): void => onChange(Object.fromEntries(pairs));
  const shadowed = new Set(entries.map(([key]) => key));

  return (
    <Group
      label="Environment for this context"
      hint="Added to every gh, az and Jira call made in this context: GH_CONFIG_DIR for another GitHub account, AZURE_CONFIG_DIR for another tenant, JIRA_API_TOKEN for another site."
    >
      {entries.map(([key, value], index) => (
        <div className="row" key={index}>
          <input
            value={key}
            placeholder="GH_CONFIG_DIR"
            onChange={(e) => write(entries.map((p, i) => (i === index ? [e.target.value, p[1]] : p)))}
          />
          <input
            value={value}
            placeholder="~/.config/gh-client"
            onChange={(e) => write(entries.map((p, i) => (i === index ? [p[0], e.target.value] : p)))}
          />
          <button
            className="remove"
            title="remove"
            onClick={() => write(entries.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      {Object.entries(inherited)
        .filter(([key]) => !shadowed.has(key))
        .map(([key, value]) => (
          <div className="row" key={`inherited-${key}`}>
            <input value={key} disabled aria-label={`${key} (inherited)`} />
            <input value={value} disabled aria-label={`${key} value (inherited)`} />
            <span className="hint">— inherited</span>
          </div>
        ))}
      <button className="add" onClick={() => write([...entries, ["", ""]])}>
        + add
      </button>
    </Group>
  );
}

/**
 * The extensions a scope runs, one switch each. The caller resolves what `selected` means for
 * its scope — the concrete list, the absent-means-all rule folded away — so this draws the
 * truth and hands the truth back. `onInherit`, in a workspace, drops its own selection again.
 */
export function ExtensionToggles({
  known,
  selected,
  onInherit,
  onChange,
}: {
  known: KnownExtension[];
  /** Which extensions exist here, concretely. */
  selected: string[];
  /** Drop this scope's own selection and inherit the global one again. */
  onInherit?: () => void;
  onChange: (extensions: string[]) => void;
}): JSX.Element {
  const enabled = (name: string): boolean => selected.includes(name);
  const toggle = (name: string, on: boolean): void =>
    onChange(known.map((e) => e.name).filter((n) => (n === name ? on : enabled(n))));

  return (
    <Group
      label="Extensions"
      hint="What this context has at all: cards, wizard steps, hooks. Unchecked is absent here, not empty."
    >
      {known.map(({ name, title }) => (
        <label className="switch" key={name}>
          <input
            type="checkbox"
            checked={enabled(name)}
            onChange={(e) => toggle(name, e.target.checked)}
          />
          <span>{title}</span>
        </label>
      ))}
      {onInherit && (
        <small className="hint">
          <button type="button" className="link" onClick={onInherit}>
            use Global&apos;s
          </button>
        </small>
      )}
    </Group>
  );
}
