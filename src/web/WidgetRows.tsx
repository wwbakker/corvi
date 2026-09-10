import { useState } from "react";
import type { WidgetItem } from "./api.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { Progress } from "./Progress.tsx";

/** A row's state dot, shared by a widget's heading and its rows. */
export function Dot({ state }: { state?: string }) {
  return <span className={`dot ${state ?? "none"}`} />;
}

/** A row and its children, collapsible like a project tree. Rows are open by default: the
 * hierarchy exists to group, not to hide. */
export function Item({
  item,
  onAction,
  busy,
  depth = 0,
}: {
  item: WidgetItem;
  onAction: (actionId: string, arg?: string) => void;
  busy: boolean;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const children = item.children ?? [];
  return (
    <>
      <div className={`item depth-${depth}`} style={{ paddingLeft: depth * 22 }}>
        {children.length > 0 ? (
          <button className="toggle" onClick={() => setOpen(!open)} title={open ? "Collapse" : "Expand"}>
            {open ? "−" : "+"}
          </button>
        ) : (
          <span className="toggle-spacer" />
        )}
        <Dot state={item.state} />
        <span className="label">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.label}
            </a>
          ) : (
            item.label
          )}
        </span>
        <span className={`detail ${item.detailTone ?? ""}`}>{item.detail}</span>
        {item.progress && <Progress {...item.progress} />}
        <span className="spacer" />
        {item.menu?.length ? (
          <ActionsMenu
            className="dots"
            label="⋯"
            actions={item.menu.map((a) => ({
              label: a.label,
              disabled: busy,
              onSelect: () => {
                if (!a.confirm || window.confirm(a.confirm)) onAction(a.id, a.arg);
              },
            }))}
          />
        ) : null}
        {(item.actions ?? []).map((a) => (
          <button
            key={a.id + (a.arg ?? "")}
            disabled={busy}
            // Anything that could surprise asks first; the server refuses the rest outright.
            onClick={() => (!a.confirm || window.confirm(a.confirm)) && onAction(a.id, a.arg)}
          >
            {a.label}
          </button>
        ))}
      </div>
      {open &&
        children.map((child) => (
          <Item
            key={child.label}
            item={child}
            busy={busy}
            onAction={onAction}
            depth={depth + 1}
          />
        ))}
    </>
  );
}
