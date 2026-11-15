/** The documentation panel beside a file editor: every field the file vocabulary has, what it is
 * for, the values it takes and what an absent one means. The entries are the owning package's
 * (`@corvi/actions/fields`, `@corvi/agents/fields`); this renders them and lights the one the
 * caret is in, scrolling it into view. */
import { type JSX, useEffect, useRef } from "react";

/** The shape both vocabularies' field documentation already has. */
export type FieldDoc = {
  readonly name: string;
  readonly required: boolean;
  readonly about: string;
  readonly defaultValue?: string;
  readonly values:
    | { readonly kind: "choices"; readonly choices: readonly string[] }
    | { readonly kind: "text"; readonly note: string };
};

/** One field's entry. `at` is the field the caret is in, if this one is it. */
function FieldEntry({
  doc,
  at,
  onAt,
}: {
  doc: FieldDoc;
  at: boolean;
  /** Where the lit entry is, so the panel can scroll to it. */
  onAt: (node: HTMLElement | null) => void;
}): JSX.Element {
  return (
    <section ref={onAt} className={at ? "field at" : "field"}>
      <h4>
        <code>{doc.name}</code>
        <span className="summary">
          {doc.required ? "required" : doc.defaultValue ? `default: ${doc.defaultValue}` : ""}
        </span>
      </h4>
      <p>{doc.about}</p>
      <p className="values">
        {doc.values.kind === "choices" ? (
          <>
            {doc.values.choices.map((choice) => (
              <code key={choice}>{choice}</code>
            ))}
          </>
        ) : (
          <span className="note">{doc.values.note}</span>
        )}
      </p>
    </section>
  );
}

export function FieldDocs({
  docs,
  title,
  ariaLabel,
  highlight,
}: {
  docs: readonly FieldDoc[];
  title: string;
  ariaLabel: string;
  highlight?: string;
}): JSX.Element {
  const lit = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Nearest, so a field at the panel's edge takes the least scroll that shows it — and one
    // already in view takes none at all.
    lit.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  return (
    <aside className="action-docs" aria-label={ariaLabel}>
      <h3>{title}</h3>
      <p className="hint">the field your caret is in is lit</p>
      {docs.map((doc) => (
        <FieldEntry
          key={doc.name}
          doc={doc}
          at={doc.name === highlight}
          onAt={(node) => {
            if (doc.name === highlight) lit.current = node;
          }}
        />
      ))}
    </aside>
  );
}
