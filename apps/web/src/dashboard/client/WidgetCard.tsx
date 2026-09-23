import { type JSX, useCallback, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { aborted, apiClient, type CardInfo, type Change, type Widget } from "../../app-root/api.ts";
import { useCached } from "../../app-root/cache.ts";
import { usePolled } from "../../app-root/poll.ts";
import { useCardEditor } from "./CardEditor.tsx";
import { Dot, Item, Refreshing } from "./WidgetRows.tsx";

/** One card, loading and refreshing itself: a slow CLI delays its own widget and nothing else. */
export function WidgetCard({
  changeId,
  change,
  workspace,
  info,
  onSaved,
}: {
  changeId: string;
  /** The change itself, once it has loaded: the editor needs it, the rows do not. */
  change?: Change;
  /** The change's context, for its editor's fetches. */
  workspace?: string;
  info: CardInfo;
  /** The editor wrote the change: this is where it goes. */
  onSaved: (change: Change) => void;
}): JSX.Element {
  const [widget, setWidget] = useCached<Widget>(`${changeId}:${info.name}`);
  const [busy, setBusy] = useState(false);
  const editor = useCardEditor({ info, change, workspace, onSaved });

  const load = useCallback(
    (signal?: AbortSignal): Promise<void> =>
      apiClient
        .card(ChangeId.make(changeId), info.name, { signal })
        .then(setWidget)
        .catch((e: Error) => {
          if (aborted(e)) return;
          setWidget({
            integration: info.name,
            title: info.title,
            state: "error",
            summary: e.message,
            items: [],
          });
        }),
    [changeId, info.name, info.title],
  );

  // A slow CLI delays its own widget and nothing else, so the mark is the card's own.
  const { refreshing, updated } = usePolled(load, 15_000);

  const act = (actionId: string, arg?: string): Promise<void> => {
    setBusy(true);
    return apiClient
      .cardAction(ChangeId.make(changeId), info.name, actionId, arg)
      .then(setWidget)
      .catch((e: Error) => setWidget({ ...widget!, state: "error", summary: e.message }))
      .finally(() => setBusy(false));
  };

  return (
    <section className={`widget ${widget ? "" : "loading"}`}>
      <h3 title={updated}>
        <Dot state={widget?.state} />
        {info.title}
        {refreshing && <Refreshing />}
        {editor.button}
      </h3>
      {/* The summary is only worth the line while loading, or when it carries an error. */}
      {(!widget || widget.state === "error") && (
        <div className="summary">{widget ? widget.summary : "loading…"}</div>
      )}
      {(widget?.items ?? []).map((item) => (
        <Item key={item.label} item={item} busy={busy} onAction={act} />
      ))}
      {editor.dialog}
    </section>
  );
}
