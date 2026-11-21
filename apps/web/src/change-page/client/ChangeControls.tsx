import { type JSX, type RefObject } from "react";
import { CHANGE_STATES, type Change, type ChangeState } from "../../app-root/api.ts";
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
  blocked,
  actions,
  onActionsOpen,
  draft,
  onDraft,
  onRename,
  onState,
  moving = false,
  reopening = false,
  onReopen,
  statusRef,
  actionsRef,
}: {
  /** The record, while it is still on its way: the row shows the page's shape, the fields wait. */
  change: Change | undefined;
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
  /** A phase write is in flight: its options wait for the answer rather than sending a second. */
  moving?: boolean;
  reopening?: boolean;
  /** Undo a cancellation; only a cancelled change offers it. */
  onReopen?: () => void;
  /** Where the leader's keycaps sit on the two menus (app-root/leader.tsx). */
  statusRef?: RefObject<HTMLButtonElement | null>;
  actionsRef?: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  const name = change?.title ?? change?.branch ?? "";
  // The states a change may move between: every manual phase, `Ideation` included, and never
  // one it ends in (a word is not a merge or an abandonment).
  const states: ChangeState[] =
    change === undefined
      ? []
      : [
          ...CHANGE_STATES.filter((s) => !isFinished({ ...change, state: s })),
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
              yours to pick — a workspace that cannot be written — it is a chip with no menu
              behind it. */}
          {blocked === true ? (
            <span className={`state-chip ${stateClass(change.state)}`}>{change.state}</span>
          ) : (
            <ActionsMenu
              className={`state ${stateClass(change.state)}`}
              triggerRef={statusRef}
              label={change.state ?? "Implementation"}
              actions={states.map((state) => ({
                label: state,
                // The state you are in is not something to move to: it would be a write that
                // changes nothing. Nor is another write sent while one is in flight.
                disabled: state === change.state || moving,
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
            <ActionsMenu
              actions={actions}
              className="actions"
              triggerRef={actionsRef}
              onOpen={onActionsOpen}
            />
          )}
        </>
      )}
    </header>
  );
}
