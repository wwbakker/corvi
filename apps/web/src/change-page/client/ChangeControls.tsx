import { type JSX } from "react";
import {
  CHANGE_STATES,
  IDEATION,
  type Change,
  type ChangeState,
} from "../../app-root/api.ts";
import { ActionsMenu, type Action } from "../../app-root/ActionsMenu.tsx";
import { stateClass } from "../../app-root/stateClass.ts";
import { isFinished } from "../../domain/change.ts";

/**
 * The change's own controls, at the tabs' height: which view is showing, what the change is
 * called, where it stands, and its actions. They belong to the change rather than to any one of
 * its views — under the window's row rather than in it (docs/manual/interface.md).
 *
 * The name is typed here, in the row the menu that asks for it lives in: the window's own row
 * says nothing about the change. The rows are labels for what follows them and the actions menu
 * is the one that ends things — so the endings sit under the state they end.
 */
export function ChangeControls({
  nav,
  activeId,
  change,
  idea,
  actions,
  draft,
  onDraft,
  onOpenPage,
  onRename,
  onState,
}: {
  /** The change's views: the core's, then the extensions' tabs in load order. */
  nav: { id: string; title: string }[];
  /** Which of them is showing. */
  activeId: string;
  /** The record, while it is still on its way: the tabs are shown already, the controls with
   * it. */
  change: Change | undefined;
  /** Whether this change is still an idea: its state is not yours to pick. */
  idea: boolean;
  actions: Action[];
  /** The name being typed, or null while the field is shut. */
  draft: string | null;
  onDraft: (value: string | null) => void;
  onOpenPage: (id: string) => void;
  /** Commit the name being typed: its blur, trimmed. */
  onRename: (title: string) => void;
  /** Move the change to another state. */
  onState: (state: ChangeState) => void;
}): JSX.Element {
  return (
    <div className="change-tabs">
      <nav className="tabs">
        {nav.map((tab) => (
          <button
            key={tab.id}
            className={activeId === tab.id ? "tab current" : "tab"}
            onClick={() => onOpenPage(tab.id)}
          >
            {tab.title}
          </button>
        ))}
      </nav>
      <span className="spacer" />
      {change && (
        <>
          {draft !== null && (
            <input
              className="subject"
              autoFocus
              value={draft}
              placeholder="what this change is about"
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onDraft(null);
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={() => onRename(draft.trim())}
            />
          )}
          <select
            className={stateClass(change.state)}
            value={change.state ?? "Implementation"}
            // An idea's state is not yours to pick: starting the work is what leaves it, and
            // that does more than a word (see the actions).
            disabled={idea}
            // Your own view of where the change stands; completing it sets "Completed".
            onChange={(e) => onState(e.target.value as ChangeState)}
          >
            {/* An idea shows its one state. A started change offers the states you are in, not
                the ones a change ends in, and not `Ideation` — there is no going back over a
                branch that now exists. Picking "Completed" from a list would set the word
                without merging anything, removing a worktree or archiving the change — a label
                that lies. Ending a change is Complete or Cancel, which do the work. A change
                that has already ended still shows its own state, because a select cannot
                display what it does not offer. */}
            {idea ? (
              <option>{IDEATION}</option>
            ) : (
              <>
                {CHANGE_STATES.filter(
                  (s) => !isFinished({ ...change, state: s }) && s !== IDEATION,
                ).map((s) => (
                  <option key={s}>{s}</option>
                ))}
                {isFinished(change) && <option>{change.state}</option>}
              </>
            )}
          </select>
          {isFinished(change) ? (
            // How it ended, not only that it did: a change that was abandoned is not one that
            // landed, and the badge is the only place that says so on this page.
            <span
              className={`badge ${change.state === "Cancelled" ? stateClass(change.state) : "ok"}`}
            >
              {(change.state ?? "Completed").toLowerCase()} {change.completedAt?.slice(0, 10)}
            </span>
          ) : (
            <ActionsMenu actions={actions} />
          )}
        </>
      )}
    </div>
  );
}
