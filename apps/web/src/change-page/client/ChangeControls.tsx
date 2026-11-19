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
  onActionsOpen,
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
  /** Called when the actions menu opens: the terminal's entries are discovered afresh then. */
  onActionsOpen?: () => void;
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
  // The states a started change may move between: the ones it is in, not the ones it ends in (a
  // word is not a merge), and not Ideation (there is no going back over a branch that exists).
  const states: ChangeState[] =
    change === undefined
      ? []
      : [
          ...CHANGE_STATES.filter((s) => s !== IDEATION && !isFinished({ ...change, state: s })),
          // A change that has already ended still shows its own state, because a menu cannot
          // display what it does not offer.
          ...(isFinished(change) ? [change.state ?? "Completed"] : []),
        ];
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
          {/* The state is a menu, not a native select: the list has to look like the page's other
              menus, and a select's dropdown is the platform's to paint. Where the state is not
              yours to pick — an idea, or a workspace that cannot be written — it is a chip with
              no menu behind it. */}
          {idea || blocked === true ? (
            <span className={`state-chip ${stateClass(change.state)}`}>{change.state}</span>
          ) : (
            <ActionsMenu
              className={`state ${stateClass(change.state)}`}
              label={change.state ?? "Implementation"}
              actions={states.map((state) => ({
                label: state,
                // The state you are in is not something to move to: it would be a write that
                // changes nothing.
                disabled: state === change.state,
                onSelect: () => onState(state),
              }))}
            />
          )}
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
            <ActionsMenu actions={actions} className="actions" onOpen={onActionsOpen} />
          )}
        </>
      )}
    </header>
  );
}
