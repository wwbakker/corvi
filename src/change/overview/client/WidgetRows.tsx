import { type JSX, useState } from "react";
import type { WidgetItem } from "../../../frontend/api.ts";
import { ActionsMenu } from "../../../frontend/ActionsMenu.tsx";
import { Progress } from "./Progress.tsx";
import { ago } from "../../../core/domain/time.ts";
import { moment } from "../../../frontend/moment.ts";

/** A row's state dot, shared by a widget's heading and its rows. */
export function Dot({ state }: { state?: string }): JSX.Element {
  return <span className={`dot ${state ?? "none"}`} />;
}

/** The heading's note that a card is asking the server again, for fetches slow enough to notice:
 * "loading…" means nothing yet, this means more is on the way. */
export function Refreshing(): JSX.Element {
  return <span className="refreshing">refreshing…</span>;
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
}): JSX.Element {
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
        {/* How long ago the row's moment was, with the exact moment for the times "3h ago" is not
            precise enough. A row that is still running carries none: the progress bar beside it
            is already counting from the same moment. */}
        {item.at && (
          <span className="at" title={moment(item.at)}>
            {ago(item.at)}
          </span>
        )}
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
