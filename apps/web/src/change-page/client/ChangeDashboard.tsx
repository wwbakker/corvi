import { type JSX } from "react";
import { type CardInfo, type Change } from "../../app-root/api.ts";
import { CompletionCard } from "../../dashboard/client/CompletionCard.tsx";
import { PerRepoCard } from "../../dashboard/client/PerRepoCard.tsx";
import { WidgetCard } from "../../dashboard/client/WidgetCard.tsx";
import { repoPathsOf } from "../../domain/change.ts";
import { WidgetHost, type WidgetInfo } from "../../integrations/client.tsx";
import { CheckoutsCard } from "./CheckoutsCard.tsx";

/**
 * The dashboard's two regions: the change's documents on the left, the status on the right —
 * every card the full width of its column. An empty side is dropped rather than given half the
 * window by the grid.
 *
 * The cards are unmounted rather than hidden while you are in the terminal: their per-repository
 * CLI calls hold every connection the browser allows per origin for seconds at a time, and the
 * terminal's own polling would queue behind them. Coming back repaints from the cache and
 * refreshes.
 */
export function ChangeDashboard({
  id,
  change,
  infos,
  widgets,
  generation,
  completing,
  onSaved,
  onFinished,
}: {
  id: string;
  change: Change | undefined;
  /** The cards the server listed for this change's workspace, and the client-drawn widgets. */
  infos: CardInfo[] | undefined;
  widgets: WidgetInfo[] | undefined;
  /** Bumped to remount the cards, so they re-read the world after a merge. */
  generation: number;
  completing: boolean;
  /** A card's editor saved: the change it wrote is the response, and the world is stale. */
  onSaved: (updated: Change) => void;
  /** The completion card finished the change: the record it wrote is the change now. */
  onFinished: (updated: Change) => void;
}): JSX.Element {
  const card = (info: CardInfo): JSX.Element =>
    info.perRepo ? (
      <PerRepoCard
        key={`${info.name}-${generation}`}
        changeId={id}
        change={change}
        workspace={change?.workspace}
        info={info}
        repos={change ? repoPathsOf(change) : []}
        onSaved={onSaved}
      />
    ) : (
      <WidgetCard
        key={`${info.name}-${generation}`}
        changeId={id}
        change={change}
        workspace={change?.workspace}
        info={info}
        onSaved={onSaved}
      />
    );

  return (
    <div className="widgets">
      <div className="column documents">
        {(infos ?? []).filter((i) => i.column === "left").map(card)}
        {/* Client-drawn documents: textareas and other client state a polled card cannot hold.
            Deliberately not keyed by generation — a remount after a merge would drop in-flight
            typing. Nothing to hand a widget before the change loads, so they wait for it; the
            cards do not. */}
        {change &&
          (widgets ?? [])
            .filter((w) => w.column === "left")
            .map((w) => (
              <WidgetHost
                key={`${w.extension}:${w.id}`}
                info={w}
                change={change}
                workspace={change.workspace}
              />
            ))}
      </div>
      <div className="column status">
        <CompletionCard changeId={id} busy={completing} onFinished={onFinished} />
        {/* The change's own checkout facts: local changes only, because the legacy records the
            read projects are local. */}
        {change && !change.workspace && <CheckoutsCard changeId={id} />}
        {(infos ?? []).filter((i) => i.column !== "left").map(card)}
        {change &&
          (widgets ?? [])
            .filter((w) => w.column !== "left")
            .map((w) => (
              <WidgetHost
                key={`${w.extension}:${w.id}`}
                info={w}
                change={change}
                workspace={change.workspace}
              />
            ))}
      </div>
    </div>
  );
}
