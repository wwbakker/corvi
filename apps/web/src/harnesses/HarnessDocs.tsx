/** The harness file's resolved environment beside its editor: which change it is shown for, the
 * chain, every section's effective items, the instructions and the warnings — with the field
 * documentation below. The view comes from the server's generator, so it is what a pane starts. */
import { type JSX, useEffect, useMemo, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type { HarnessListResponseDto, HarnessSummaryDto } from "@corvi/contracts/harnesses";
import { harnessFieldDocs } from "@corvi/agents/fields";

import { type Change } from "../app-root/api.ts";
import { useChanges } from "../app-root/state.ts";
import { useSourceOwner } from "../app-root/sources.ts";
import { FieldDocs } from "../app-root/FieldDocs.tsx";
import { isFinished } from "../domain/change.ts";
import { getPref, setPref } from "../app-root/prefs.ts";
import type { EditorFile } from "../app-root/FileEditor.tsx";

const CHANGE_KEY = "corvi:harness-view-change";

const sectionNames = ["extensions", "skills", "packages", "mcp"] as const;

function ItemList({ view }: { view: NonNullable<HarnessSummaryDto["view"]> }): JSX.Element {
  return (
    <>
      {sectionNames.map((name) => {
        const section = view.sections[name];
        return (
          <section key={name} className="harness-section">
            <h4>
              <code>{name}</code> <span className="summary">mode: {section.mode}</span>
            </h4>
            {section.items.length === 0 ? (
              <p className="hint">nothing</p>
            ) : (
              <ul>
                {section.items.map((item, index) => (
                  <li key={`${item.name}-${index}`} className={`harness-item ${item.state}`}>
                    <span className="name">{item.name}</span>
                    <span className="state">
                      {item.state}
                      {item.origin !== item.state && item.origin !== "added-by-corvi"
                        ? ` · ${item.origin}`
                        : ""}
                    </span>
                    {item.byCorvi === true && <span className="badge">added by Corvi</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

function View({ view }: { view: NonNullable<HarnessSummaryDto["view"]> }): JSX.Element {
  return (
    <section className="harness-view">
      <h3>{view.label}</h3>
      <p className="hint">
        <code>{view.key}</code> · {view.agent} · chain {view.chain.map((link) => link.id).join(" → ")}
      </p>
      <p className="hint">
        generated: <code>{view.generatedDir}</code>
      </p>
      <p className="hint">
        instructions: {view.instructions.origin}
        {view.model === undefined ? "" : ` · model ${view.model.id}`}
        {view.effort === undefined ? "" : ` · effort ${view.effort}`}
      </p>
      <ItemList view={view} />
      {view.warnings.length > 0 && (
        <section className="harness-warnings">
          <h4>Warnings</h4>
          <ul>
            {view.warnings.map((warning, index) => (
              <li key={index} className="warn">
                {warning.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

export function HarnessDocs({ highlight, file }: { highlight?: string; file: EditorFile }): JSX.Element {
  const { changes: allChanges } = useChanges();
  const owner = useSourceOwner();
  const changes = useMemo(() => (allChanges ?? []).filter((change) => !isFinished(change)), [allChanges]);
  const [chosen, setChosen] = useState<string>(() => getPref(CHANGE_KEY) ?? "");
  const [listed, setListed] = useState<HarnessListResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = changes.find((change) => `${change.source ?? ""}\u0000${change.id}` === chosen);

  useEffect(() => {
    if (chosen === "" && changes.length > 0) {
      setChosen(`${changes[0]?.source ?? ""}\u0000${changes[0]?.id}`);
    }
  }, [chosen, changes]);

  useEffect(() => {
    if (selected === undefined) {
      setListed(null);
      return;
    }
    setError(null);
    owner
      .clientFor(selected.source ?? "")
      .harnesses.list(ChangeId.make(selected.id))
      .then(setListed)
      .catch((e: Error) => setError(e.message));
  }, [selected?.source, selected?.id, owner, selected]);

  const target = useMemo(() => {
    const matches = (listed?.harnesses ?? []).filter((harness) => harness.id === file.id);
    return (
      matches.find(
        (harness) =>
          harness.source === file.scope &&
          (file.scope !== "repository" || harness.sourceLabel === file.repository),
      ) ?? matches[0]
    );
  }, [listed, file.id, file.scope, file.repository]);

  return (
    <div className="harness-docs">
      <section className="harness-docs-head">
        <h3>The resolved environment</h3>
        <label>
          <span>Change</span>
          <select
            aria-label="harness view change"
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
              setPref(CHANGE_KEY, event.target.value);
            }}
          >
            {changes.length === 0 && <option value="">no active changes</option>}
            {changes.map((change) => (
              <option
                key={`${change.source ?? ""}\u0000${change.id}`}
                value={`${change.source ?? ""}\u0000${change.id}`}
              >
                {change.title ?? change.branch ?? change.id}
                {change.source === undefined || change.source === "" ? "" : ` (remote)`}
              </option>
            ))}
          </select>
        </label>
      </section>
      {error !== null && <div className="error-banner">{error}</div>}
      {target?.view !== undefined && <View view={target.view} />}
      {target?.problem !== undefined && <div className="error-banner">{target.problem}</div>}
      {listed !== null && target === undefined && (
        <p className="hint">
          this file is not the harness a change currently discovers; save it and it appears here
        </p>
      )}
      <FieldDocs
        docs={harnessFieldDocs}
        title="The harness file"
        ariaLabel="harness file documentation"
        highlight={highlight}
      />
    </div>
  );
}
