import { type JSX, useEffect, useRef, useState } from "react";

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
}: {
  actions: Action[];
  label?: string;
  className?: string;
  /** Called when the menu opens — where a list is fetched fresh rather than kept in the page. */
  onOpen?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        className={className}
        aria-expanded={open}
        // Keeps the focus where it was: on the terminal tab this button sits above a terminal.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open && (
        <div className="menu-items">
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
