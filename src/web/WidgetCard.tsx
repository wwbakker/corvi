import { type JSX, useCallback, useState } from "react";
import { aborted, api, post, type CardInfo, type Widget } from "./api.ts";
import { useCached } from "./cache.ts";
import { usePolled } from "./poll.ts";
import { Dot, Item, Refreshing } from "./WidgetRows.tsx";

/** One card, loading and refreshing itself: a slow CLI delays its own widget and nothing else. */
export function WidgetCard({ changeId, info }: { changeId: string; info: CardInfo }): JSX.Element {
  const [widget, setWidget] = useCached<Widget>(`${changeId}:${info.name}`);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal): Promise<void> =>
      api<Widget>(`/changes/${changeId}/${info.name}`, { signal })
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
    return post<Widget>(`/changes/${changeId}/${info.name}/${actionId}`, { arg })
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
      </h3>
      {/* The summary is only worth the line while loading, or when it carries an error. */}
      {(!widget || widget.state === "error") && (
        <div className="summary">{widget ? widget.summary : "loading…"}</div>
      )}
      {(widget?.items ?? []).map((item) => (
        <Item key={item.label} item={item} busy={busy} onAction={act} />
      ))}
    </section>
  );
}
