import { type JSX, useEffect, useState } from "react";
import { ChangeId } from "@corvi/contracts/changes";
import type {
  TranscriptDto,
  TranscriptEntryDto,
  TranscriptSummaryDto,
} from "@corvi/contracts/transcripts";
import { useChangeClient } from "../../app-root/sources.ts";
import { aborted } from "../../app-root/api.ts";

/** Where a session ran, as a reader recognises it: the change's own terminal, a subagent, or a
 * checkout of one of its repositories. */
export const placeOf = (where: string): string => {
  if (!where) return "change terminal";
  const subagent = /^subagents\/([^/]+)/.exec(where);
  if (subagent) return `subagent ${subagent[1]}`;
  return where;
};

const timeOf = (at?: string): string => (at ? at.slice(0, 16).replace("T", " ") : "");

/** One step of the conversation. What was said reads as text; what the agent thought, called and
 * got back is folded away, because that is most of a session and rarely what you look for first. */
function Entry({ entry }: { entry: TranscriptEntryDto }): JSX.Element {
  switch (entry._tag) {
    case "Message":
      return entry.role === "system" ? (
        <details className="entry system">
          <summary>system prompt</summary>
          <pre>{entry.text}</pre>
        </details>
      ) : (
        <div className={`entry message ${entry.role}`}>
          <div className="who">
            {entry.role === "user" ? "You" : "Agent"}
            <span className="when">{timeOf(entry.at)}</span>
          </div>
          <div className="text">{entry.text}</div>
        </div>
      );
    case "Thinking":
      return (
        <details className="entry thinking">
          <summary>thinking</summary>
          <pre>{entry.text}</pre>
        </details>
      );
    case "ToolCall":
      return (
        <details className="entry tool">
          <summary>
            <span className="tool-name">{entry.name}</span> call
          </summary>
          <pre>{entry.input}</pre>
        </details>
      );
    case "ToolResult":
      return (
        <details className={entry.error ? "entry tool error" : "entry tool"}>
          <summary>
            <span className="tool-name">{entry.name}</span> {entry.error ? "failed" : "result"}
          </summary>
          <pre>{entry.output}</pre>
        </details>
      );
    case "Note":
      return <div className="entry note">{entry.text}</div>;
  }
}

/**
 * The agent sessions kept with a finished change: every conversation an agent had in it — its own
 * terminal, its subagents, its checkouts — copied when the change was archived. A list on the
 * left, the selected conversation on the right; the copies themselves are the change's
 * `transcripts/` files, kept whole for whatever reads them later.
 */
export function TranscriptsPage({ changeId }: { changeId: string }): JSX.Element {
  const client = useChangeClient();
  const [list, setList] = useState<readonly TranscriptSummaryDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    client.changes
      .transcripts(ChangeId.make(changeId), { signal: ac.signal })
      .then((found) => {
        setList(found);
        setSelected((current) => current ?? found[0]?.id ?? null);
      })
      .catch((e: Error) => {
        if (!aborted(e) && !ac.signal.aborted) setError(e.message);
      });
    return () => ac.abort();
  }, [changeId, client]);

  useEffect(() => {
    if (!selected) return setTranscript(null);
    const ac = new AbortController();
    setTranscript(null);
    client.changes
      .transcript(ChangeId.make(changeId), selected, { signal: ac.signal })
      .then(setTranscript)
      .catch((e: Error) => {
        // Picking another session abandons this one's read: that is not a failure.
        if (!aborted(e) && !ac.signal.aborted) setError(e.message);
      });
    return () => ac.abort();
  }, [changeId, client, selected]);

  if (list === null) return <p className="hint">{error ?? "loading…"}</p>;
  if (list.length === 0)
    return (
      <p className="hint">
        No agent sessions were kept for this change. They are copied when a change is completed or
        cancelled, from the agents' own session stores.
      </p>
    );

  return (
    <div className="transcripts">
      <div className="sessions">
        {error && <div className="error-banner">{error}</div>}
        {list.map((summary) => (
          <button
            key={summary.id}
            className={summary.id === selected ? "session selected" : "session"}
            title={summary.cwd}
            onClick={() => setSelected(summary.id)}
          >
            <span className="title">{summary.title ?? summary.sessionId}</span>
            <span className="meta">
              {placeOf(summary.where)} · {summary.harness} · {timeOf(summary.startedAt)} ·{" "}
              {summary.entries} entries
            </span>
          </button>
        ))}
      </div>
      <div className="conversation">
        {transcript ? (
          transcript.entries.map((entry, index) => <Entry key={index} entry={entry} />)
        ) : (
          <p className="hint">loading…</p>
        )}
      </div>
    </div>
  );
}
