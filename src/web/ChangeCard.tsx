import { useEffect, useState } from "react";
import { api, type Change } from "./api.ts";
import type { ChangeSummary } from "../types.ts";
import { stateClass } from "./changeState.tsx";
import { moment } from "./moment.ts";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * One fact about a change, as a coloured dot and a phrase. Facts that say nothing are left out
 * by the card rather than shown as a zero: an overview is read at a glance, and a row of zeroes
 * is noise.
 */
function Fact({ state, children }: { state: string; children: React.ReactNode }) {
  return (
    // Nothing happening reads as grey: the eye should land on the cards that want attention.
    <span className={state === "none" ? "fact idle" : "fact"}>
      <span className={`dot ${state}`} />
      {children}
    </span>
  );
}

/**
 * A change you are still working on, as a card: room for what is happening to it — builds
 * running, things running in its terminal, review comments waiting — which is what you open the
 * overview to find out, and which a table row has no space for.
 *
 * The numbers come from their own request per card, because they cost CLI calls: a change whose
 * Azure DevOps is slow leaves the other cards alone.
 */
export function ChangeCard({ change, onOpen }: { change: Change; onOpen: () => void }) {
  const [summary, setSummary] = useState<ChangeSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<ChangeSummary>(`/changes/${change.id}/summary`)
        .then((s) => alive && setSummary(s))
        .catch(() => {});
    void load();
    // Builds finish and comments arrive while the overview is open; a minute is soon enough
    // for a page you are not looking at closely, and the calls behind it are not free.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [change.id]);

  return (
    <article className="change-card" onClick={onOpen}>
      {/* What it is, on its own line: the id and the ticket's summary read as one sentence. */}
      <div className="top">
        <h3>{change.id}</h3>
        {/* The branch stands in when there is no ticket, and reads as the identifier it is. */}
        <span className={change.title ? "story" : "branch"}>{change.title ?? change.branch}</span>
      </div>
      {/* How it is doing, underneath: state on the left, dates on the right. */}
      <div className="bottom">
        <p className="facts">
          <Fact state={summary && summary.pipelines > 0 ? "pending" : "none"}>
            {!summary
              ? "…"
              : summary.pipelines > 0
                ? `${plural(summary.pipelines, "pipeline")} active`
                : "pipelines idle"}
          </Fact>
          <Fact state={summary && summary.terminals > 0 ? "ok" : "none"}>
            {!summary
              ? "…"
              : summary.terminals > 0
                ? `${plural(summary.terminals, "terminal process", "terminal processes")} active`
                : "terminals idle"}
          </Fact>
          {/* Nothing at all when every thread is resolved: an empty inbox needs no line. */}
          {summary && summary.unresolved > 0 && (
            <Fact state="warn">{plural(summary.unresolved, "unresolved comment")}</Fact>
          )}
        </p>
        <span className={`badge ${stateClass(change.state)}`}>{change.state ?? "In Progress"}</span>
        <p className="meta">
          {plural(change.repos.length, "repository", "repositories")} · created{" "}
          {moment(change.createdAt)}
        </p>
      </div>
    </article>
  );
}
