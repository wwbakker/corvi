import { type JSX, useCallback, useRef, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import { aborted, type CardInfo, type Change, type Widget } from "../../app-root/api.ts";
import { changeKey, useChangeClient, useSource, useSourceAvailability } from "../../app-root/sources.ts";
import { gateFailureOf } from "../../app-root/sourceOwner.ts";
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
  const client = useChangeClient();
  const source = useSource();
  // Cached widgets are keyed by target generation too: a same-id retarget remounts this card, and
  // without the generation it would seed the new target's card from the old target's cache.
  const availability = useSourceAvailability(source);
  const generation = availability.generation;
  // A blocked workspace is not asked: the card keeps what it has, and `blocked` in the load's
  // identity restarts the poll the moment the source recovers instead of waiting the interval.
  const blocked = availability.status._tag !== "available";
  const [widget, setWidget] = useCached<Widget>(
    `${changeKey(source, changeId)}@${generation}:${info.name}`,
  );
  const [busy, setBusy] = useState(false);
  // The newest load and action, so a slow answer that belongs to an older attempt (or an older
  // target) cannot set the card back.
  const loadSeq = useRef(0);
  const actSeq = useRef(0);
  const editor = useCardEditor({ info, change, workspace, onSaved });

  const load = useCallback(
    (signal?: AbortSignal): Promise<void> => {
      if (blocked) return Promise.resolve();
      const seq = ++loadSeq.current;
      return client
        .dashboard.card(ChangeId.make(changeId), info.name, { signal })
        .then((next) => {
          if (loadSeq.current === seq) setWidget(next);
        })
        .catch((e: unknown) => {
          if (aborted(e) || loadSeq.current !== seq) return;
          // A gate transition — checking, unavailable, a retired read — is the workspace going
          // away, not this card failing: keep the last known rows and let the banner explain.
          // A genuine failure (or an uncertain write) is the card's to show.
          const gate = gateFailureOf(e);
          if (gate !== undefined && gate.kind !== "uncertain") return;
          setWidget({
            integration: info.name,
            title: info.title,
            state: "error",
            summary: e instanceof Error ? e.message : String(e),
            items: [],
          });
        });
    },
    [changeId, info.name, info.title, blocked],
  );

  // A slow CLI delays its own widget and nothing else, so the mark is the card's own.
  const { refreshing, updated } = usePolled(load, 15_000);

  const act = (actionId: string, arg?: string): Promise<void> => {
    // The disabled fieldset already keeps the buttons from being clicked; this is the same rule
    // at the transport seam.
    if (blocked) return Promise.resolve();
    const seq = ++actSeq.current;
    setBusy(true);
    return client
      .dashboard.cardAction(ChangeId.make(changeId), info.name, actionId, arg)
      .then((next) => {
        if (actSeq.current === seq) setWidget(next);
      })
      .catch((e: unknown) => {
        // Still surfaced: a genuine failure or an uncertain outcome is what the user must see.
        if (actSeq.current === seq) {
          setWidget({ ...widget!, state: "error", summary: e instanceof Error ? e.message : String(e) });
        }
      })
      .finally(() => {
        if (actSeq.current === seq) setBusy(false);
      });
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
