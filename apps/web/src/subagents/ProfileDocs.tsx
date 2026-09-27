/** The documentation panel beside the profile editor: every field the profile file has, what it
 * is for, the values it takes and what an absent one means — so the vocabulary is readable
 * where the file is written, without leaving for the manual.
 *
 * The entries are `@corvi/agents/fields`' (the vocabulary's own documentation); this renders
 * them and lights the one the caret is in (`../actions/caretField.ts`), scrolling it into view. */
import { type JSX, useEffect, useRef } from "react";

import { profileFieldDocs, type ProfileFieldDoc } from "@corvi/agents/fields";

/** One field's entry. `at` is the field the caret is in, if this one is it. */
function FieldEntry({
  doc,
  at,
  onAt,
}: {
  doc: ProfileFieldDoc;
  at: boolean;
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

export function ProfileDocs({ highlight }: { highlight?: string }): JSX.Element {
  const lit = useRef<HTMLElement | null>(null);
  useEffect(() => {
    lit.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  return (
    <aside className="action-docs" aria-label="profile file documentation">
      <h3>The profile file</h3>
      <p className="hint">the field your caret is in is lit</p>
      {profileFieldDocs.map((doc) => (
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
