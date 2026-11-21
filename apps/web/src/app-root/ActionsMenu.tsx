import { type JSX, useEffect, useRef, useState, type RefObject } from "react";

import { ChevronDownIcon } from "./icons.tsx";
import { useLeaderMenu } from "./leader.tsx";

export type Action = {
  label: string;
  disabled?: boolean;
  /** Set apart by a line above it: the destructive ones should not sit flush with the rest. */
  separated?: boolean;
  /** Shown on hover, typically why it is disabled. */
  title?: string;
  onSelect: () => void | Promise<void>;
};

/** A button that opens a list of actions. Closes on Escape, on an outside click, and after
 * picking something, which is all a menu owes you. */
export function ActionsMenu({
  actions,
  label = "Actions ▾",
  className = "primary",
  onOpen,
  triggerRef,
}: {
  actions: Action[];
  label?: string;
  className?: string;
  /** Called when the menu opens — where a list is fetched fresh rather than kept in the page. */
  onOpen?: () => void;
  /** The trigger's element, for a caller that puts the leader's keycap on it and presses it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);

  // An open menu is the leader's list: its items are numbered, the arrows walk them and Enter
  // presses one (app-root/leader.tsx). The mode stays on when this opens, so the numbers are what
  // comes next.
  useLeaderMenu(open, () => ({
    items: () =>
      itemsRef.current === null
        ? []
        : [...itemsRef.current.querySelectorAll<HTMLElement>("button")].map((element) => ({ element })),
    outline: () => itemsRef.current,
    close: () => setOpen(false),
  }));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape is the menu's while it is open, and it is taken rather than passed on: closing the
    // menu must not also send an Escape to the terminal underneath. Capture phase because the
    // terminal encodes keys as input and swallows the keydown before it would ever bubble to a
    // listener here.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        ref={triggerRef}
        className={className}
        aria-expanded={open}
        // Keeps the focus where it was: on the terminal tab this button sits above a terminal.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {/* The chevron is the button's, not part of the label: a trigger is a name and the shape
            that says it opens. Callers that still spell the arrow in the label keep working. The
            name is its own box so a narrow row shortens it instead of pushing the trigger past the
            row's edge (the sidebar's workspace pill is the narrow case). */}
        <span className="menu-label">{label.replace(/\s*▾\s*$/, "")}</span>
        <span className="caret" aria-hidden="true">
          <ChevronDownIcon title="opens a menu" />
        </span>
      </button>
      {open && (
        <div className="menu-items" ref={itemsRef} data-leader-menu>
          {actions.map((action) => (
            <button
              key={action.label}
              className={action.separated ? "separated" : undefined}
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                setOpen(false);
                void action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
