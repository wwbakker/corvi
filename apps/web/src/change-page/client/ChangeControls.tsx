import { type JSX } from "react";
import { CHANGE_STATES, IDEATION, type Change, type ChangeState } from "../../app-root/api.ts";
import { ActionsMenu, type Action } from "../../app-root/ActionsMenu.tsx";
import { BranchIcon } from "../../app-root/icons.tsx";
import { StaleMarker } from "../../app-root/RemoteAvailability.tsx";
import { stateClass } from "../../app-root/stateClass.ts";
import { isFinished } from "../../domain/change.ts";

/**
 * The change's title row: what the change is (its name, id and branch), where it stands, and its
 * actions. In the app window this row is the title bar — the band you drag the window by — so it
 * holds no tabs: the views and the terminal windows share the row under it.
 *
 * The name is typed here, in the row the menu that asks for it lives in. Every field is a label
 * for what follows the row, and the actions menu is the one that ends things, so the endings sit
 * under the state they end.
 */
export function ChangeControls({
  change,
  idea,
  blocked,
  actions,
  draft,
  onDraft,
  onRename,
  onState,
  reopening = false,
  onReopen,
}: {
  /** The record, while it is still on its way: the row shows the page's shape, the fields wait. */
  change: Change | undefined;
  /** Whether this change is still an idea: its state is not yours to pick. */
  idea: boolean;
  /** The workspace is unavailable: the state select and an already-open rename are held back —
   * the transport gate would refuse them, and the UI must not offer a mutation it cannot make. */
  blocked?: boolean;
  actions: Action[];
  /** The name being typed, or null while the field is shut. */
  draft: string | null;
  onDraft: (value: string | null) => void;
  /** Commit the name being typed: its blur, trimmed. */
  onRename: (title: string) => void;
  /** Move the change to another state. */
  onState: (state: ChangeState) => void;
  reopening?: boolean;
  /** Undo a cancellation; only a cancelled change offers it. */
  onReopen?: () => void;
}): JSX.Element {
  const name = change?.title ?? change?.branch ?? "";
  return (
    <header className="change-bar">
      <div className="change-title">
        {draft === null ? (
          <h1 className="change-name" title={name}>
            {name}
          </h1>
        ) : (
          <input
            className="subject"
            autoFocus
            value={draft}
            placeholder="what this change is about"
            disabled={blocked === true}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onDraft(null);
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={() => onRename(draft.trim())}
          />
        )}
        {change && (
          <>
            <span className="change-id">{change.id}</span>
            <span className="change-branch" title={change.branch}>
              <BranchIcon title="branch" />
              <span className="change-branch-name">{change.branch}</span>
            </span>
          </>
        )}
      </div>
      {blocked && <StaleMarker>unavailable</StaleMarker>}
      {change && (
        <>
          <select
            className={stateClass(change.state)}
            value={change.state ?? "Implementation"}
            // An idea's state is not yours to pick: starting the work is what leaves it, and
            // that does more than a word (see the actions). An unavailable workspace cannot
            // write the state either, so the select is disabled rather than refused on click.
            disabled={idea || blocked === true}
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
                {CHANGE_STATES.filter((s) => !isFinished({ ...change, state: s }) && s !== IDEATION).map(
                  (s) => (
                    <option key={s}>{s}</option>
                  ),
                )}
                {isFinished(change) && <option>{change.state}</option>}
              </>
            )}
          </select>
          {isFinished(change) ? (
            <>
              {/* How it ended, not only that it did: a change that was abandoned is not one that
                  landed, and the badge is the only place that says so on this page. */}
              <span className={`badge ${change.state === "Cancelled" ? stateClass(change.state) : "ok"}`}>
                {(change.state ?? "Completed").toLowerCase()} {change.completedAt?.slice(0, 10)}
              </span>
              {/* A cancelled change can come back: its worktrees are made again and the work
                  cancelling shelved is put back. A completed one landed, and stays a record. */}
              {change.state === "Cancelled" && onReopen && (
                <button
                  type="button"
                  disabled={reopening || blocked === true}
                  title={`Bring it back as ${change.cancelledFrom ?? "Implementation"}: the worktrees and the shelved work come back`}
                  onClick={onReopen}
                >
                  {reopening ? "Reopening…" : "Reopen"}
                </button>
              )}
            </>
          ) : (
            <ActionsMenu actions={actions} />
          )}
        </>
      )}
    </header>
  );
}
