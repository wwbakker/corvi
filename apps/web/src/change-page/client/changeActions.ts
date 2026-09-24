import type { Action } from "../../app-root/ActionsMenu.tsx";
import type { Completion } from "../../app-root/api.ts";

/**
 * The change's actions menu: what it is called, how the work starts, and — last and apart — the
 * two ways a change ends. Everything above the endings is reversible. An idea has a third —
 * starting the work — which is the only way out of `Ideation` and the reason it is an action
 * rather than a word the state select offers.
 *
 * Pure: the words, the order and the rules live here, and the page says what clicking one does.
 */
export function changeActions(spec: {
  /** Whether this change is still an idea: its endings are then Discard, not Complete and Cancel. */
  idea: boolean;
  starting: boolean;
  completing: boolean;
  cancelling: boolean;
  /** The last readiness poll, for the hover: the click re-checks fresh, so this is orientation,
   * not the decision. */
  completion: Completion | undefined;
  onRename: () => void;
  onStart: () => void;
  onCopyDescription: () => void;
  onComplete: () => void;
  onCancel: () => void;
}): Action[] {
  const { idea, starting, completing, cancelling, completion } = spec;
  // Renaming sits in the menu rather than on the name itself: the row the name is in is the
  // window's title bar in the app, and a button there would be a hole in the region you drag
  // the window by (docs/manual/interface.md).
  const rename: Action = {
    label: "Rename change",
    title: "A name of your own; the ticket's summary is only a suggestion",
    onSelect: spec.onRename,
  };
  return idea
    ? [
        rename,
        {
          label: starting ? "Starting…" : "Start work",
          disabled: starting,
          title: "Leave Ideation: create the worktrees and move the ticket",
          onSelect: spec.onStart,
        },
        {
          label: cancelling ? "Discarding…" : "Discard idea",
          separated: true,
          disabled: cancelling || starting,
          title: "Archive this idea as cancelled; nothing was created",
          onSelect: spec.onCancel,
        },
      ]
    : [
        rename,
        { label: "Copy PR description", onSelect: spec.onCopyDescription },
        {
          label: completing ? "Completing…" : "Complete change",
          separated: true,
          disabled: completing,
          title: completion?.ready
            ? "Ready to complete"
            : completion?.reasons.join("\n") || "Check whether the change is ready",
          onSelect: spec.onComplete,
        },
        {
          label: cancelling ? "Cancelling…" : "Cancel change",
          disabled: cancelling || completing,
          title: "Abandon this change: the worktrees go, nothing is merged",
          onSelect: spec.onCancel,
        },
      ];
}
