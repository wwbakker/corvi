import { useEffect, useRef, useState } from "react";

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
export function ActionsMenu({ actions }: { actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button className="primary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Actions ▾
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
