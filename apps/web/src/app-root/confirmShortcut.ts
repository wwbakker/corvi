import { useEffect, useRef, type RefObject } from "react";

/**
 * `Ctrl+Enter` confirms the dialog it is attached to: the one key that goes on from a modal
 * browser to the answer it was opened for (the repository list, the directory picker's choice).
 * It is read on the dialog itself, in the capture phase, so a field inside it — the filter, a
 * name — cannot swallow it, and so it never reaches the page behind the modal.
 *
 * The same key outside a dialog creates the wizard's idea (apps/web/src/wizard/Wizard.tsx), which
 * is why this stops at the dialog: one keystroke, one answer.
 */
/** The keyboard event's shape, so a caller can test one without constructing a DOM event. */
export type Keyish = {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

/** Whether a modal dialog has the keyboard. Every global chord asks this before it does anything:
 * a dialog's own controls are the whole surface while it is open, and a chord that fell through
 * could press them (Space activates a button). */
export const modalOpen = (): boolean => document.querySelector("dialog[open]") !== null;

/** `Ctrl+Enter` and nothing else: the confirm key of a dialog, and the wizard's create key
 * outside one. One predicate, so the two cannot drift. */
export const isConfirmChord = (event: Keyish): boolean =>
  (event.code === "Enter" || event.code === "NumpadEnter") &&
  event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  !event.shiftKey;

export function useConfirmShortcut(
  dialog: RefObject<HTMLDialogElement | null>,
  open: boolean,
  onConfirm: () => void,
): void {
  const latest = useRef(onConfirm);
  latest.current = onConfirm;
  useEffect(() => {
    const element = dialog.current;
    if (!open || element === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (!isConfirmChord(event)) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current();
    };
    element.addEventListener("keydown", onKey, true);
    return () => element.removeEventListener("keydown", onKey, true);
  }, [dialog, open]);
}
